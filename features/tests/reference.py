"""Computes AdFlush features with the original YOPO code (AdFlush fork + WebGraph) and writes them as test fixture.

Needs node/npm and Python 3.8 with: tldextract==5.1.2 beautifulsoup4 numpy==1.21.6 pandas tqdm gensim scikit-learn six

    python tests/reference.py --yopo ../../robustness-evaluation/YOPO tests/fixtures/expected.json tests/fixtures/js/* tests/fixtures/html/*

Every .js file becomes a "script" case, every .html file a "sub_frame" case.
"""
import __future__
import argparse
import ast
import glob
import importlib.util
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile

import tldextract
from sklearn import preprocessing

# use the suffix list bundled with tldextract (same as data/public_suffix_list.dat) instead of downloading the latest
tldextract.tldextract.TLD_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)

# (url, top_level_url, content_policy_type). Only characters that are in reqwordvec.json / fqdnwordvec.json,
# because the Python code throws on unknown characters.
URLS = [
    ("https://www.example.com/index.html", "https://www.example.com/", "main_frame"),
    ("https://cdn.example.com/static/app.js", "https://www.example.com/", "script"),
    ("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://www.theguardian.com/", "script"),
    ("https://pagead2.googlesyndication.com/pagead/ads?client=ca-pub-1&format=300x250&adk=1", "https://news.example.co.uk/", "sub_frame"),
    ("https://www.google-analytics.com/collect?v=1&_v=j101&t=pageview&tid=UA-1", "https://shop.example.co.uk/cart", "ping"),
    ("http://192.168.0.1:8080/ads/banner.png", "http://192.168.0.1/", "image"),
    ("http://10.0.0.1/track", "https://example.org/", "xmlhttprequest"),
    ("https://user:pw@sub.domain.example.org:443/path?q=1#frag", "https://example.org", "stylesheet"),
    ("https://foo.bar.unknowntld/x.js", "https://bar.unknowntld/", "script"),
    ("https://www.city.kawasaki.jp/a", "https://city.kawasaki.jp/", "font"),
    ("https://a.b.ck/", "https://www.ck/", "media"),
    ("https://shop.example.xn--p1ai/", "https://example.xn--p1ai/", "object"),
    ("https://[2001:db8::1]/ad", "https://example.com/", "websocket"),
    ("adserver.com/banner", "https://adserver.com", "other"),
    ("//cdn.adnxs.com/ast/ast.js", "https://example.com/", "script"),
    ("https://example.com/?zoneid=12&siteid=4", "https://example.com/", "beacon"),
    ("https://example.com/pb.min.js", "https://example.com/", "script"),
    ("https://example.com/pbxmin.js", "https://example.com/", "script"),
    ("https://example.com/static/ADVERT.js", "https://example.com/", "script"),
    ("ad.example.com/x", "https://example.com/", "csp_report"),
    ("https://example.com/download", "https://example.com/", "imageset"),
    ("https://example.com/a/b/c", "https://example.com/", "webbundle"),
]


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_function(path, name, globals_):
    # MY_embedding.py runs its whole pipeline on import and graph/utils.py needs Python 3.9 annotations,
    # so only the function definition is executed, with lazy annotations
    tree = ast.parse(open(path).read())
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name]
    exec(compile(tree, path, "exec", flags=__future__.annotations.compiler_flag), globals_)
    return globals_[name]


def embedding(adflush_encodings, text, is_request_url):
    # MY_embedding.py skips the row when a character has no vector
    try:
        return adflush_encodings.char2vec_pretrained(text, is_request_url).tolist()
    except KeyError:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--yopo", required=True)
    parser.add_argument("out")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    yopo = os.path.abspath(args.yopo)
    out = os.path.abspath(args.out)
    files = [os.path.abspath(f) for f in args.files]

    # adflush_encodings.py reads json/, ast_parser.js and MY_jsfile/ relative to the working directory
    work = tempfile.mkdtemp()
    shutil.copytree(f"{yopo}/AdFlush/source/json", f"{work}/json")
    shutil.copy(f"{yopo}/AdFlush/source/ast_parser.js", work)
    os.makedirs(f"{work}/MY_jsfile")
    subprocess.run(["npm", "install", "--silent", "--prefix", work, "acorn-loose@8.4.0", "acorn@8.11.3"], check=True)
    os.chdir(work)

    sys.path.insert(0, f"{yopo}/AdFlush/source")
    sys.path.insert(0, f"{yopo}/WebGraph/code")
    import adflush_encodings

    content = load_module(f"{yopo}/WebGraph/code/features/content.py", "webgraph_content")
    get_domain = load_function(f"{yopo}/WebGraph/code/graph/utils.py", "get_domain", {"tldextract": tldextract})
    extract_fqdn = load_function(f"{yopo}/AdFlush/source/MY_embedding.py", "extract_fqdn", {"tldextract": tldextract})
    label_encoder = preprocessing.LabelEncoder()
    label_encoder.fit(["Request", "Script", "Document", "Element", "Storage"])

    cases = [{"url": u, "top_level_url": t, "content_policy_type": c, "body": ""} for u, t, c in URLS]
    for i, path in enumerate(files):
        url, top_level_url, _ = URLS[i % 4]
        content_policy_type = "script" if path.endswith(".js") else "sub_frame"
        body = open(path, encoding="utf8", newline="").read()
        cases.append({"name": os.path.basename(path), "url": url, "top_level_url": top_level_url,
                      "content_policy_type": content_policy_type, "body": body})

    for i, case in enumerate(cases):
        url, top_level_url, content_policy_type = case["url"], case["top_level_url"], case["content_policy_type"]
        node_dict = {
            "type": "Request",
            "attr": json.dumps({"content_policy_type": content_policy_type}),
            "domain": get_domain(url),
            "top_level_domain": get_domain(top_level_url),
        }
        node_values, node_names = content.get_node_features(url, node_dict, label_encoder)
        url_values, url_names = content.get_url_features(url, node_dict)
        webgraph = dict(zip(node_names + url_names, node_values + url_values))

        js = (0, 0, 0, 0, 0, 0, 0, 0, 0, {})
        case["acorn_asts"] = []
        if content_policy_type in ("script", "sub_frame", "main_frame"):
            is_html = content_policy_type != "script"
            name = f"case{i}"
            with open(f"MY_jsfile/{name}{'.html' if is_html else '.js'}", "w", encoding="utf8", newline="") as f:
                f.write(case["body"])
            # MY_embedding.py calls the extractor 9 frames deep (module-level Process -> pipeline). Deeply nested
            # ASTs hit Python's recursion limit, so the limit is shifted to leave the same room as there.
            sys.setrecursionlimit(1000 + len(inspect.stack()) - 9)
            # same handling as MY_embedding.py
            try:
                js = adflush_encodings.extract_JS_Features_shine_with_timeout(file_name=name, _isHTML=is_html, timeout=180, out_name=name)
                if len(js) != 10:
                    raise ValueError
            except Exception:
                js = (0, 0, 0, 0, 0, 0, 0, 0, 0, {})
            # the ASTs ast_parser.js wrote, so tests can feed Rust the exact acorn-loose output
            scripts = [f"MY_jsfile/{name}"]
            if is_html:
                scripts = [f"MY_jsfile/{name}_{k}" for k in range(len(glob.glob(f"MY_jsfile/{name}_*.js")))]
            for script in scripts:
                ast_json = ""
                if os.path.exists(f"{script}.txt"):
                    ast_json = open(f"{script}.txt", encoding="utf8").read()
                    ast_json = ast_json[len('{"ast":'):-1]
                case["acorn_asts"].append(ast_json)
        _, _, avg_ident, avg_charperline, brackettodot, num_requests_sent, num_set_storage, num_get_storage, num_get_cookie, ngram = js

        content_dict = json.load(open("json/content_type_dict.json"))
        case["expected"] = {
            "content_policy_type": content_dict.get(content_policy_type),
            "url_length": webgraph["url_length"],
            "is_third_party": webgraph["is_third_party"],
            "keyword_raw_present": webgraph["keyword_char_present"],
            "brackettodot": brackettodot,
            "num_get_storage": num_get_storage,
            "num_set_storage": num_set_storage,
            "num_get_cookie": num_get_cookie,
            "num_requests_sent": num_requests_sent,
            "avg_ident": avg_ident,
            "avg_charperline": avg_charperline,
            "ngrams": ngram if isinstance(ngram, dict) else {},
            "fqdn": extract_fqdn(url),
            "req_url": embedding(adflush_encodings, url, True),
            "fqdn_vec": embedding(adflush_encodings, extract_fqdn(url), False),
        }

    with open(out, "w") as f:
        json.dump(cases, f, indent=1, ensure_ascii=False)
    shutil.rmtree(work)


if __name__ == "__main__":
    main()

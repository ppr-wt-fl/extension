pub mod js;
pub mod url;

use std::cell::OnceCell;
use wasm_bindgen::prelude::*;

/// The request a feature vector is computed for.
pub struct Request<'a> {
    pub url: &'a str,
    pub top_level_url: &'a str,
    pub content_policy_type: &'a str,
    /// Response body: JavaScript for "script", HTML for "sub_frame" and "main_frame", ignored otherwise.
    pub body: Option<&'a str>,
    /// acorn-loose ASTs of the scripts, see `js::request_features`. Without them the scripts are parsed with oxc.
    pub acorn_asts: Option<&'a [String]>,
}

/// The named features of a request, in the given order. To add a feature, add a match arm.
/// Intermediates shared by several features are computed on first use, so the body is only parsed for JS features.
pub fn features(names: &[impl AsRef<str>], req: &Request) -> Result<Vec<f64>, String> {
    let js = OnceCell::new();
    let js = || js.get_or_init(|| js::request_features(req));
    let req_url = OnceCell::new();
    let req_url = || {
        req_url
            .get_or_init(|| url::req_url_embedding(req.url))
            .as_slice()
    };
    let fqdn = OnceCell::new();
    let fqdn = || {
        fqdn.get_or_init(|| url::fqdn_embedding(&url::fqdn(req.url)))
            .as_slice()
    };

    let feature = |name: &str| {
        Some(match name {
            "content_policy_type" => url::content_policy_type(req.content_policy_type),
            "url_length" => url::url_length(req.url),
            "is_third_party" => url::is_third_party(req.url, req.top_level_url) as u8 as f64,
            // YOPO stores WebGraph's keyword_char_present under this name
            "keyword_raw_present" => url::keyword_char_present(req.url) as u8 as f64,
            "avg_ident" => js().avg_ident,
            "avg_charperline" => js().avg_charperline,
            "brackettodot" => js().brackettodot,
            "num_requests_sent" => js().num_requests_sent,
            "num_set_storage" => js().num_set_storage,
            "num_get_storage" => js().num_get_storage,
            "num_get_cookie" => js().num_get_cookie,
            // ng_<a>_<b>_<c>: frequency of the AST node token trigram a, b, c
            _ if name.starts_with("ng_") => js().ngrams.get(name).copied().unwrap_or(0.0),
            // req_url_<i> and fqdn_<i>: dimension i of the request URL and FQDN embeddings
            _ => dimension(name, "req_url_", req_url).or_else(|| dimension(name, "fqdn_", fqdn))?,
        })
    };
    names
        .iter()
        .map(|name| {
            feature(name.as_ref()).ok_or_else(|| format!("unknown feature {}", name.as_ref()))
        })
        .collect()
}

fn dimension<'a>(name: &str, prefix: &str, embedding: impl FnOnce() -> &'a [f64]) -> Option<f64> {
    let i: usize = name.strip_prefix(prefix)?.parse().ok()?;
    embedding().get(i).copied()
}

/// `features` for JS, throws on unknown names.
/// `body` is the response body: JavaScript for "script", HTML for "sub_frame" and "main_frame", ignored otherwise.
/// Scripts are parsed with oxc, unless `acorn_asts` has them parsed by acorn-loose 8.4.0 like the Python pipeline:
/// `acorn_asts[i]` is `JSON.stringify(acornLoose.parse(script, {ecmaVersion: 2022}))`, "" if that threw.
/// The scripts are `[body]` for "script" and `inline_scripts(body)` for "sub_frame" and "main_frame".
#[wasm_bindgen]
pub fn extract(
    names: Vec<String>,
    url: &str,
    top_level_url: &str,
    content_policy_type: &str,
    body: Option<String>,
    acorn_asts: Option<Vec<String>>,
) -> Result<Vec<f64>, JsError> {
    let req = Request {
        url,
        top_level_url,
        content_policy_type,
        body: body.as_deref(),
        acorn_asts: acorn_asts.as_deref(),
    };
    features(&names, &req).map_err(|e| JsError::new(&e))
}

/// Intermediates behind the features, for tests and debugging: JSON `{"fqdn": string, "ngrams": {name: value}}`
/// with every n-gram of the body, not only the requested ones. Arguments as in `extract`.
#[wasm_bindgen]
pub fn inspect(
    url: &str,
    top_level_url: &str,
    content_policy_type: &str,
    body: Option<String>,
    acorn_asts: Option<Vec<String>>,
) -> String {
    let js = js::request_features(&Request {
        url,
        top_level_url,
        content_policy_type,
        body: body.as_deref(),
        acorn_asts: acorn_asts.as_deref(),
    });
    serde_json::json!({ "fqdn": url::fqdn(url), "ngrams": js.ngrams }).to_string()
}

/// Non-empty inline scripts of an HTML document, with newlines normalized to "\n".
#[wasm_bindgen]
pub fn inline_scripts(html: &str) -> Vec<String> {
    let html = html.replace("\r\n", "\n").replace('\r', "\n");
    js::inline_scripts(&html)
        .into_iter()
        .map(String::from)
        .collect()
}

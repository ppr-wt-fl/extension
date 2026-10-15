use crate::Request;
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use regex::Regex;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

// Python raises RecursionError (and the script gets no features) when the AST JSON nests deeper than this.
// Measured with tests/reference.py, which leaves as much stack room as MY_embedding.py.
const MAX_AST_DEPTH: usize = 975;

#[derive(Debug, Default, Clone)]
pub struct JsFeatures {
    pub avg_ident: f64,
    pub avg_charperline: f64,
    pub brackettodot: f64,
    pub num_requests_sent: f64,
    pub num_set_storage: f64,
    pub num_get_storage: f64,
    pub num_get_cookie: f64,
    pub ngrams: HashMap<String, f64>,
}

struct Script {
    features: JsFeatures,
    ngram_counts: HashMap<(u32, u32, u32), f64>,
    ngram_len: usize,
}

struct Regexes {
    clean: Regex,
    request: Regex,
    set_storage: Regex,
    get_storage: Regex,
    get_cookie: Regex,
    script_tag: Regex,
}

/// Script features of the request's body, all 0 unless content_policy_type is "script", "sub_frame" or "main_frame".
/// `req.acorn_asts` are acorn ASTs of the body (for "script") or of `inline_scripts(body)`, see `js_features`.
pub fn request_features(req: &Request) -> JsFeatures {
    let body = req.body.unwrap_or("");
    match req.content_policy_type {
        "script" => js_features(
            body,
            req.acorn_asts
                .map(|asts| asts.first().map(String::as_str).unwrap_or("")),
        ),
        "sub_frame" | "main_frame" => html_features(body, req.acorn_asts),
        _ => JsFeatures::default(),
    }
}

fn regexes() -> &'static Regexes {
    static REGEXES: OnceLock<Regexes> = OnceLock::new();
    // AdFlush's SETSTOR, GETSTOR and GETCOOK without lookarounds, which the regex crate lacks:
    // `(?!=)*` and `(?!;\n)=` never reject anything, and lookaheads for `;`, newline or whitespace consume
    // that character instead. No match starts with such a character, so the match count stays the same.
    REGEXES.get_or_init(|| Regexes {
        clean: Regex::new(r#"(?s)"[^"]*\.?[^"]*"|'[^']*\.?[^']*'|\d+\.\d+|//[^\n]*|/\*.*?\*/"#)
            .unwrap(),
        request: Regex::new(r"https?://").unwrap(),
        set_storage: Regex::new(
            r"(Storage\.setItem)|(Storage\[[^]]+\] *=)|(Storage\.[^=;\n]+=)|(Storage *=)",
        )
        .unwrap(),
        get_storage: Regex::new(
            r"(Storage\.get)|(Storage\[[^]]+\][\n;])|(Storage\.[\w]+[;\n])|(Storage[;\s])",
        )
        .unwrap(),
        get_cookie: Regex::new(
            r"(cookies?\.get)|(cookies?\[[^]]+\][\n;])|(cookies?\.[\w]+[;\n])|(cookies?[;\s])",
        )
        .unwrap(),
        script_tag: Regex::new(r"(?is)<!--.*?-->|<script\b[^>]*>(.*?)</\s*script\s*>").unwrap(),
    })
}

/// Features of a JavaScript file (content_policy_type "script").
/// `acorn_ast` is `JSON.stringify(acornLoose.parse(source, {ecmaVersion: 2022}))`, "" if that threw.
/// Without it the source is parsed with oxc, which differs from acorn-loose on code it has to recover.
pub fn js_features(source: &str, acorn_ast: Option<&str>) -> JsFeatures {
    let source = normalize_newlines(source);
    let Some(script) = script_features(&source, acorn_ast) else {
        return JsFeatures::default();
    };
    let mut features = script.features;
    features.ngrams = script
        .ngram_counts
        .into_iter()
        .map(|((a, b, c), n)| (format!("ng_{a}_{b}_{c}"), n / script.ngram_len as f64))
        .collect();
    features
}

/// Features of an HTML document: max over its inline scripts, n-grams pooled over all scripts.
/// `acorn_asts` has one acorn AST per script of `inline_scripts(html)`.
pub fn html_features(html: &str, acorn_asts: Option<&[String]>) -> JsFeatures {
    let html = normalize_newlines(html);
    let mut features = JsFeatures::default();
    let mut ngram_counts: HashMap<(u32, u32, u32), f64> = HashMap::new();
    let mut total_ngram_len = 0;
    for (i, source) in inline_scripts(&html).into_iter().enumerate() {
        let acorn_ast = acorn_asts.map(|asts| asts.get(i).map(String::as_str).unwrap_or(""));
        let Some(script) = script_features(source, acorn_ast) else {
            continue;
        };
        total_ngram_len += script.ngram_len;
        for (k, c) in script.ngram_counts {
            *ngram_counts.entry(k).or_default() += c;
        }
        let f = script.features;
        features.avg_ident = features.avg_ident.max(f.avg_ident);
        features.avg_charperline = features.avg_charperline.max(f.avg_charperline);
        features.brackettodot = features.brackettodot.max(f.brackettodot);
        features.num_requests_sent = features.num_requests_sent.max(f.num_requests_sent);
        features.num_set_storage = features.num_set_storage.max(f.num_set_storage);
        features.num_get_storage = features.num_get_storage.max(f.num_get_storage);
        features.num_get_cookie = features.num_get_cookie.max(f.num_get_cookie);
    }
    features.ngrams = ngram_counts
        .into_iter()
        .map(|((a, b, c), n)| (format!("ng_{a}_{b}_{c}"), n / total_ngram_len as f64))
        .collect();
    features
}

// Python reads files with universal newlines
fn normalize_newlines(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// Non-empty <script> bodies, like BeautifulSoup's html.parser. Newlines must already be "\n".
pub fn inline_scripts(html: &str) -> Vec<&str> {
    regexes()
        .script_tag
        .captures_iter(html)
        .filter_map(|c| c.get(1))
        .map(|m| m.as_str())
        .filter(|s| !s.is_empty())
        .collect()
}

// None where the Python pipeline throws and the script gets no features
fn script_features(source: &str, acorn_ast: Option<&str>) -> Option<Script> {
    let oxc_json;
    let json = match acorn_ast {
        Some(json) => json,
        None => {
            oxc_json = oxc_ast(source);
            &oxc_json
        }
    };
    let (types, ident_len, ident_count) = walk_ast(json, acorn_ast.is_some())?;

    let token_dict = ngram_token_dict();
    let mut tokens = Vec::new();
    for t in &types {
        tokens.push(*token_dict.get(t.as_ref())?);
    }
    let mut ngram_counts: HashMap<(u32, u32, u32), f64> = HashMap::new();
    let mut ngram_len = 0;
    if tokens.len() >= 3 {
        ngram_len = tokens.len() - 2;
        for w in tokens.windows(3) {
            *ngram_counts.entry((w[0], w[1], w[2])).or_default() += 1.0;
        }
    }

    let lines: Vec<&str> = source.split('\n').collect();
    let char_count: usize = lines.iter().map(|l| l.chars().count()).sum();

    let r = regexes();
    let js_clean = r.clean.replace_all(source, "").into_owned();
    let dot_count = js_clean.matches('.').count();
    let bracket_count = js_clean.matches(['[', ']', '(', ')']).count();

    let features = JsFeatures {
        avg_ident: if ident_count > 0 {
            ident_len as f64 / ident_count as f64
        } else {
            0.0
        },
        avg_charperline: char_count as f64 / lines.len() as f64,
        brackettodot: if dot_count > 0 {
            bracket_count as f64 / dot_count as f64
        } else {
            0.0
        },
        num_requests_sent: r.request.find_iter(source).count() as f64,
        num_set_storage: r.set_storage.find_iter(&js_clean).count() as f64,
        num_get_storage: r.get_storage.find_iter(&js_clean).count() as f64,
        num_get_cookie: r.get_cookie.find_iter(&js_clean).count() as f64,
        ngrams: HashMap::new(),
    };
    Some(Script {
        features,
        ngram_counts,
        ngram_len,
    })
}

fn ngram_token_dict() -> &'static HashMap<String, u32> {
    static DICT: OnceLock<HashMap<String, u32>> = OnceLock::new();
    DICT.get_or_init(|| {
        serde_json::from_str(include_str!("../data/ngram_token_dict.json")).unwrap()
    })
}

fn oxc_ast(source: &str) -> String {
    // wasm is single-threaded; reusing the arena avoids reallocating its chunks per script
    thread_local!(static ALLOCATOR: std::cell::RefCell<Allocator> = Default::default());
    ALLOCATOR.with_borrow_mut(|allocator| {
        allocator.reset();
        oxc_ast_in(allocator, source)
    })
}

fn oxc_ast_in(allocator: &Allocator, source: &str) -> String {
    let options = ParseOptions {
        preserve_parens: false,
        ..ParseOptions::default()
    };
    let parsed = Parser::new(allocator, source, SourceType::script())
        .with_options(options)
        .parse();
    parsed.program.to_estree_json(false, false)
}

// The parts of the ESTree JSON walk needs; deserializing straight into this skips serde_json::Value's
// IndexMap and owned strings. Strings borrow from the JSON unless they contain escapes.
enum N<'a> {
    Obj(Vec<(Cow<'a, str>, N<'a>)>),
    Arr(Vec<N<'a>>),
    Str(Cow<'a, str>),
    Leaf,
}

impl<'a> N<'a> {
    // Linear scan: ESTree nodes have few keys. Last match wins, like a map with a duplicate key.
    fn get<'b>(kids: &'b [(Cow<'a, str>, N<'a>)], key: &str) -> Option<&'b N<'a>> {
        kids.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

struct Key<'a>(Cow<'a, str>);

impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_str(NVisitor).and_then(|n| match n {
            N::Str(s) => Ok(Key(s)),
            _ => Err(de::Error::custom("expected key")),
        })
    }
}

impl<'de> Deserialize<'de> for N<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NVisitor)
    }
}

struct NVisitor;

impl<'de> Visitor<'de> for NVisitor {
    type Value = N<'de>;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("JSON")
    }
    fn visit_borrowed_str<E>(self, s: &'de str) -> Result<N<'de>, E> {
        Ok(N::Str(Cow::Borrowed(s)))
    }
    fn visit_str<E>(self, s: &str) -> Result<N<'de>, E> {
        Ok(N::Str(Cow::Owned(s.to_owned())))
    }
    fn visit_bool<E>(self, _: bool) -> Result<N<'de>, E> {
        Ok(N::Leaf)
    }
    fn visit_i64<E>(self, _: i64) -> Result<N<'de>, E> {
        Ok(N::Leaf)
    }
    fn visit_u64<E>(self, _: u64) -> Result<N<'de>, E> {
        Ok(N::Leaf)
    }
    fn visit_f64<E>(self, _: f64) -> Result<N<'de>, E> {
        Ok(N::Leaf)
    }
    fn visit_unit<E>(self) -> Result<N<'de>, E> {
        Ok(N::Leaf)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<N<'de>, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(N::Arr(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<N<'de>, A::Error> {
        let mut kids = Vec::new();
        while let Some((Key(k), v)) = map.next_entry()? {
            kids.push((k, v));
        }
        Ok(N::Obj(kids))
    }
}

// Walks the ESTree JSON like Python's treewalk. Acorn JSON is walked in its own key order,
// oxc JSON in acorn's order from child_keys. Returns (node types in post-order, identifier length sum, identifier count).
fn walk_ast(json: &str, acorn_order: bool) -> Option<(Vec<Cow<'_, str>>, usize, usize)> {
    let mut deserializer = serde_json::Deserializer::from_str(json);
    deserializer.disable_recursion_limit();
    let ast = N::deserialize(&mut deserializer).ok()?;

    let mut types = Vec::new();
    let mut ident_len = 0;
    let mut ident_count = 0;
    walk(
        &ast,
        1,
        acorn_order,
        &mut types,
        &mut ident_len,
        &mut ident_count,
    )?;
    Some((types, ident_len, ident_count))
}

fn walk<'a>(
    value: &N<'a>,
    depth: usize,
    acorn_order: bool,
    types: &mut Vec<Cow<'a, str>>,
    ident_len: &mut usize,
    ident_count: &mut usize,
) -> Option<()> {
    if depth > MAX_AST_DEPTH {
        return None;
    }
    match value {
        N::Arr(items) => {
            for item in items {
                walk(item, depth + 1, acorn_order, types, ident_len, ident_count)?;
            }
        }
        N::Obj(node) => {
            // acorn's JSON.stringify throws on BigInt values, so ast_parser.js produces no AST
            if node.iter().any(|(k, _)| k == "bigint") {
                return None;
            }
            let node_type = match N::get(node, "type") {
                Some(N::Str(s)) => Some(s),
                _ => None,
            };
            if acorn_order {
                for (_, child) in node {
                    walk(child, depth + 1, acorn_order, types, ident_len, ident_count)?;
                }
            } else if let Some(node_type) = node_type {
                for key in child_keys(node_type) {
                    if let Some(child) = N::get(node, key) {
                        walk(child, depth + 1, acorn_order, types, ident_len, ident_count)?;
                    }
                }
            }
            if node_type.is_some_and(|t| t == "Identifier") {
                let Some(N::Str(name)) = N::get(node, "name") else {
                    return None;
                };
                *ident_len += name.chars().count();
                *ident_count += 1;
            }
            if let Some(node_type) = node_type {
                types.push(node_type.clone());
            }
        }
        _ => {}
    }
    Some(())
}

// Child properties in the order acorn creates them, which is the order Python iterates them.
// oxc serializes some in a different order (e.g. LabeledStatement label before body).
fn child_keys(node_type: &str) -> &'static [&'static str] {
    match node_type {
        "ArrayExpression" | "ArrayPattern" => &["elements"],
        "ArrowFunctionExpression" | "FunctionDeclaration" | "FunctionExpression" => {
            &["id", "params", "body"]
        }
        "AssignmentExpression" | "AssignmentPattern" | "BinaryExpression" | "LogicalExpression" => {
            &["left", "right"]
        }
        "AwaitExpression" | "RestElement" | "ReturnStatement" | "SpreadElement"
        | "ThrowStatement" | "UnaryExpression" | "UpdateExpression" | "YieldExpression" => {
            &["argument"]
        }
        "BlockStatement" | "ClassBody" | "Program" | "StaticBlock" => &["body"],
        "BreakStatement" | "ContinueStatement" => &["label"],
        "CallExpression" | "NewExpression" => &["callee", "arguments"],
        "CatchClause" => &["param", "body"],
        "ChainExpression" | "ExpressionStatement" => &["expression"],
        "ClassDeclaration" | "ClassExpression" => &["id", "superClass", "body"],
        "ConditionalExpression" | "IfStatement" => &["test", "consequent", "alternate"],
        "DoWhileStatement" => &["body", "test"],
        "ExportAllDeclaration" => &["exported", "source"],
        "ExportDefaultDeclaration" => &["declaration"],
        "ExportNamedDeclaration" => &["declaration", "specifiers", "source"],
        "ExportSpecifier" => &["local", "exported"],
        "ForInStatement" | "ForOfStatement" => &["left", "right", "body"],
        "ForStatement" => &["init", "update", "test", "body"],
        "ImportDeclaration" => &["specifiers", "source"],
        "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" => &["local"],
        "ImportExpression" => &["source"],
        "ImportSpecifier" => &["imported", "local"],
        "LabeledStatement" => &["body", "label"],
        "MemberExpression" => &["object", "property"],
        "MetaProperty" => &["meta", "property"],
        "MethodDefinition" | "Property" | "PropertyDefinition" => &["key", "value"],
        "ObjectExpression" | "ObjectPattern" => &["properties"],
        "SequenceExpression" => &["expressions"],
        "SwitchCase" => &["consequent", "test"],
        "SwitchStatement" => &["discriminant", "cases"],
        "TaggedTemplateExpression" => &["tag", "quasi"],
        "TemplateLiteral" => &["expressions", "quasis"],
        "TryStatement" => &["block", "handler", "finalizer"],
        "VariableDeclaration" => &["declarations"],
        "VariableDeclarator" => &["id", "init"],
        "WhileStatement" => &["test", "body"],
        "WithStatement" => &["object", "body"],
        _ => &[],
    }
}

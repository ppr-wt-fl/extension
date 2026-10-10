use crate::Request;
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use regex::Regex;
use serde_json::Value;
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
    ngram_counts: HashMap<String, f64>,
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
        .map(|(k, c)| (k, c / script.ngram_len as f64))
        .collect();
    features
}

/// Features of an HTML document: max over its inline scripts, n-grams pooled over all scripts.
/// `acorn_asts` has one acorn AST per script of `inline_scripts(html)`.
pub fn html_features(html: &str, acorn_asts: Option<&[String]>) -> JsFeatures {
    let html = normalize_newlines(html);
    let mut features = JsFeatures::default();
    let mut ngram_counts: HashMap<String, f64> = HashMap::new();
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
        .map(|(k, c)| (k, c / total_ngram_len as f64))
        .collect();
    features
}

// Python reads files with universal newlines
fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
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
    let (types, ident_len, ident_count) = match acorn_ast {
        Some(json) => walk_ast(json, true)?,
        None => walk_ast(&oxc_ast(source), false)?,
    };

    let token_dict = ngram_token_dict();
    let mut tokens = Vec::new();
    for t in &types {
        tokens.push(*token_dict.get(t)?);
    }
    let mut ngram_counts: HashMap<String, f64> = HashMap::new();
    let mut ngram_len = 0;
    if tokens.len() >= 3 {
        ngram_len = tokens.len() - 2;
        for w in tokens.windows(3) {
            *ngram_counts
                .entry(format!("ng_{}_{}_{}", w[0], w[1], w[2]))
                .or_default() += 1.0;
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
    let allocator = Allocator::default();
    let options = ParseOptions {
        preserve_parens: false,
        ..ParseOptions::default()
    };
    let parsed = Parser::new(&allocator, source, SourceType::script())
        .with_options(options)
        .parse();
    parsed.program.to_estree_json(false, false)
}

// Walks the ESTree JSON like Python's treewalk. Acorn JSON is walked in its own key order,
// oxc JSON in acorn's order from child_keys. Returns (node types in post-order, identifier length sum, identifier count).
fn walk_ast(json: &str, acorn_order: bool) -> Option<(Vec<String>, usize, usize)> {
    let mut deserializer = serde_json::Deserializer::from_str(json);
    deserializer.disable_recursion_limit();
    let ast: Value = serde::Deserialize::deserialize(&mut deserializer).ok()?;

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

fn walk(
    value: &Value,
    depth: usize,
    acorn_order: bool,
    types: &mut Vec<String>,
    ident_len: &mut usize,
    ident_count: &mut usize,
) -> Option<()> {
    if depth > MAX_AST_DEPTH {
        return None;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                walk(item, depth + 1, acorn_order, types, ident_len, ident_count)?;
            }
        }
        Value::Object(node) => {
            // acorn's JSON.stringify throws on BigInt values, so ast_parser.js produces no AST
            if node.contains_key("bigint") {
                return None;
            }
            let node_type = node.get("type").and_then(Value::as_str);
            if acorn_order {
                for child in node.values() {
                    walk(child, depth + 1, acorn_order, types, ident_len, ident_count)?;
                }
            } else if let Some(node_type) = node_type {
                for key in child_keys(node_type) {
                    if let Some(child) = node.get(*key) {
                        walk(child, depth + 1, acorn_order, types, ident_len, ident_count)?;
                    }
                }
            }
            if node_type == Some("Identifier") {
                *ident_len += node["name"].as_str()?.chars().count();
                *ident_count += 1;
            }
            if let Some(node_type) = node_type {
                types.push(node_type.to_string());
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

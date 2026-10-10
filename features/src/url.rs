use regex::Regex;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

// "pb.min" is a regex in WebGraph, so its "." matches any character
const KEYWORD_RAW: [&str; 35] = [
    "ad",
    "ads",
    "advert",
    "popup",
    "banner",
    "sponsor",
    "iframe",
    "googlead",
    "adsys",
    "adser",
    "advertise",
    "redirect",
    "popunder",
    "punder",
    "popout",
    "click",
    "track",
    "play",
    "pop",
    "prebid",
    "bid",
    "pb.min",
    "affiliate",
    "ban",
    "delivery",
    "promo",
    "tag",
    "zoneid",
    "siteid",
    "pageid",
    "size",
    "viewid",
    "zone_id",
    "google_afc",
    "google_afs",
];
const KEYWORD_CHAR: [char; 14] = [
    '.', '/', '&', '=', ';', '-', '_', '/', '*', '^', '?', ';', '|', ',',
];

const SCHEME_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

pub fn url_length(url: &str) -> f64 {
    url.chars().count() as f64
}

pub fn content_policy_type(content_type: &str) -> f64 {
    static DICT: OnceLock<HashMap<String, f64>> = OnceLock::new();
    let dict = DICT.get_or_init(|| {
        serde_json::from_str(include_str!("../data/content_type_dict.json")).unwrap()
    });
    dict.get(content_type).copied().unwrap_or(f64::NAN)
}

pub fn keyword_char_present(url: &str) -> bool {
    static KEYWORDS: OnceLock<Vec<Regex>> = OnceLock::new();
    let keywords = KEYWORDS.get_or_init(|| {
        KEYWORD_RAW
            .iter()
            .map(|k| Regex::new(&format!("(?i){k}")).unwrap())
            .collect()
    });
    for keyword in keywords {
        for m in keyword.find_iter(url) {
            // Python's url[start - 1] wraps around to the last character when start is 0
            let prev = if m.start() == 0 {
                url.chars().last()
            } else {
                url[..m.start()].chars().last()
            };
            if KEYWORD_CHAR.contains(&prev.unwrap()) {
                return true;
            }
        }
    }
    false
}

pub fn is_third_party(url: &str, top_level_url: &str) -> bool {
    let (_, domain, suffix) = tldextract(url);
    let (_, top_domain, top_suffix) = tldextract(top_level_url);
    format!("{domain}.{suffix}") != format!("{top_domain}.{top_suffix}")
}

pub fn fqdn(url: &str) -> String {
    let (subdomain, domain, suffix) = tldextract(url);
    if subdomain.is_empty() {
        format!("{domain}.{suffix}")
    } else {
        format!("{subdomain}.{domain}.{suffix}")
    }
}

pub fn req_url_embedding(url: &str) -> Vec<f64> {
    char_embedding(url, req_url_vectors())
}

pub fn fqdn_embedding(fqdn: &str) -> Vec<f64> {
    char_embedding(fqdn, fqdn_vectors())
}

fn req_url_vectors() -> &'static HashMap<char, Vec<f64>> {
    static VECTORS: OnceLock<HashMap<char, Vec<f64>>> = OnceLock::new();
    VECTORS.get_or_init(|| load_vectors(include_str!("../data/reqwordvec.json")))
}

fn fqdn_vectors() -> &'static HashMap<char, Vec<f64>> {
    static VECTORS: OnceLock<HashMap<char, Vec<f64>>> = OnceLock::new();
    VECTORS.get_or_init(|| load_vectors(include_str!("../data/fqdnwordvec.json")))
}

fn load_vectors(json: &str) -> HashMap<char, Vec<f64>> {
    let vectors: HashMap<String, Vec<f64>> = serde_json::from_str(json).unwrap();
    vectors
        .into_iter()
        .map(|(c, v)| (c.chars().next().unwrap(), v))
        .collect()
}

// Mean of the character vectors. Python raises KeyError on unknown characters, here they are skipped.
fn char_embedding(text: &str, vectors: &HashMap<char, Vec<f64>>) -> Vec<f64> {
    let dims = vectors.values().next().unwrap().len();
    let mut sum = vec![0.0; dims];
    let mut count = 0;
    for c in text.chars() {
        if let Some(vector) = vectors.get(&c) {
            for i in 0..dims {
                sum[i] += vector[i];
            }
            count += 1;
        }
    }
    if count == 0 {
        return sum;
    }
    sum.iter().map(|s| s / count as f64).collect()
}

/// Port of tldextract 5.1.2 `extract(url)` with ICANN suffixes only. Returns (subdomain, domain, suffix).
pub fn tldextract(url: &str) -> (String, String, String) {
    // "//host" is protocol-relative, otherwise only a valid "scheme://" is stripped
    let schemeless = match url.split_once("//") {
        Some(("", rest)) => rest,
        Some((prefix, rest))
            if let Some(scheme) = prefix.strip_suffix(':')
                && !scheme.is_empty()
                && scheme.chars().all(|c| SCHEME_CHARS.contains(c)) =>
        {
            rest
        }
        _ => url,
    };
    let netloc = schemeless.split(['/', '?', '#']).next().unwrap();
    let host = netloc.rsplit('@').next().unwrap();
    let host = match host.find(']') {
        Some(end) if host.starts_with('[') => &host[..=end],
        _ => host.split(':').next().unwrap().trim(),
    };

    // Like tldextract, the Unicode dots that IDNA treats as label separators
    // (U+3002 ideographic, U+FF0E fullwidth, U+FF61 halfwidth ideographic full stop) become "."
    let host = host.replace(['\u{3002}', '\u{ff0e}', '\u{ff61}'], ".");
    // No-op for bracketed hosts as they end with "]"
    let host = host.trim_end_matches('.');

    if let Some(ip) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'))
        && ip.parse::<Ipv6Addr>().is_ok()
    {
        return (String::new(), host.to_string(), String::new());
    }

    let labels: Vec<&str> = host.split('.').collect();
    let suffix_index = suffix_index(&labels);
    if suffix_index == labels.len() && host.parse::<Ipv4Addr>().is_ok() {
        return (String::new(), host.to_string(), String::new());
    }

    let (rest, suffix) = labels.split_at(suffix_index);
    let (domain, subdomain) = rest.split_last().unwrap_or((&"", &[]));
    (subdomain.join("."), domain.to_string(), suffix.join("."))
}

#[derive(Default)]
struct Trie {
    matches: HashMap<String, Trie>,
    end: bool,
}

fn suffix_trie() -> &'static Trie {
    static TRIE: OnceLock<Trie> = OnceLock::new();
    TRIE.get_or_init(|| {
        let list = include_str!("../data/public_suffix_list.dat");
        let icann = list.split("// ===BEGIN PRIVATE DOMAINS===").next().unwrap();
        let mut root = Trie::default();
        for line in icann.lines() {
            let Some(rule) = line.split_whitespace().next() else {
                continue;
            };
            if rule.starts_with("//") {
                continue;
            }
            let mut node = &mut root;
            for label in rule.split('.').rev() {
                node = node.matches.entry(label.to_string()).or_default();
            }
            node.end = true;
        }
        root
    })
}

// Index of the first suffix label, labels.len() if there is no suffix
fn suffix_index(labels: &[&str]) -> usize {
    let mut node = suffix_trie();
    let mut index = labels.len();
    for (i, label) in labels.iter().enumerate().rev() {
        let label = decode_punycode(label);
        if let Some(next) = node.matches.get(&label) {
            node = next;
            if node.end {
                index = i;
            }
        } else if node.matches.contains_key("*") {
            return if node.matches.contains_key(&format!("!{label}")) {
                i + 1
            } else {
                i
            };
        } else {
            break;
        }
    }
    index
}

fn decode_punycode(label: &str) -> String {
    let lowered = label.to_lowercase();
    if let Some(puny) = lowered.strip_prefix("xn--")
        && let Some(decoded) = idna::punycode::decode_to_string(puny)
    {
        return decoded;
    }
    lowered
}

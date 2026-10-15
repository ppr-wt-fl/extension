//! Filter list verdicts (adblock-rust), to compare with the model's. One engine per list, compiled natively
//! (`src/bin/compile.rs`) and only deserialized here.

use adblock::{Engine, request::Request};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Lists(Engine);

#[wasm_bindgen]
impl Lists {
    /// From `Engine::serialize` output.
    #[wasm_bindgen(constructor)]
    pub fn new(serialized: &[u8]) -> Result<Lists, JsError> {
        let mut engine = Engine::default();
        engine
            .deserialize(serialized)
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        Ok(Lists(engine))
    }

    /// Whether the list blocks the request, `type` is a chrome.webRequest resource type. Invalid URLs aren't blocked.
    #[wasm_bindgen(js_name = "match")]
    pub fn matches(&self, url: &str, top_level_url: &str, r#type: &str) -> bool {
        // shortcut: always GET, so $method filters (a handful in EasyList) can be off; pass the method if they matter
        Request::new(url, top_level_url, r#type, "GET")
            .is_ok_and(|req| self.0.check_network_request(&req).should_block())
    }
}

/// Network filters only: cosmetic ones can't be compared with request verdicts.
pub fn engine(text: &str) -> Engine {
    let mut set = adblock::lists::FilterSet::new(false);
    set.add_filter_list(
        text.to_owned(),
        adblock::lists::ParseOptions {
            rule_types: adblock::lists::RuleTypes::NetworkOnly,
            ..Default::default()
        },
    );
    Engine::new_with_filter_set(set)
}

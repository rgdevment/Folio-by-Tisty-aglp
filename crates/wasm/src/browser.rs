use wasm_bindgen::prelude::*;

use crate::shown::{Shown, shown};
use crate::worked;

/// A link's version, opened in the browser.
#[wasm_bindgen]
pub struct Page(Shown);

#[wasm_bindgen]
impl Page {
    #[wasm_bindgen(getter)]
    pub fn html(&self) -> String {
        self.0.html.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.0.text.to_string()
    }

    /// Title, tags, version and signatures, as JSON.
    #[wasm_bindgen(getter)]
    pub fn about(&self) -> String {
        serde_json::to_string(&self.0.about).unwrap_or_default()
    }

    #[wasm_bindgen(getter)]
    pub fn pictures(&self) -> usize {
        self.0.pictures.len()
    }

    pub fn picture(&self, at: usize) -> Option<Vec<u8>> {
        self.0.pictures.get(at).map(|(_, bytes)| bytes.to_vec())
    }

    pub fn media(&self, at: usize) -> Option<String> {
        self.0
            .pictures
            .get(at)
            .map(|(kind, _)| kind.media().to_owned())
    }
}

/// Opens the envelope, or says in one word why it would not open.
#[wasm_bindgen]
pub fn open(envelope: Vec<u8>, key: &str, limits: Option<String>) -> Result<Page, JsError> {
    shown(envelope, key, limits.as_deref())
        .map(Page)
        .map_err(|unread| JsError::new(unread.word()))
}

/// The proof a server's challenge asks for, as the JSON it takes in `Tisty-Work`.
#[wasm_bindgen]
pub fn solved(challenge: &str) -> Option<String> {
    worked::solved(challenge)
}

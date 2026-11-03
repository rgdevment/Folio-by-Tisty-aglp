use tisty_share_proto::envelope::{self, Kind};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::shown::{Begun, Shown, begun, shown};
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

    /// What the words cite, each with the id and key that open it, as JSON.
    #[wasm_bindgen(getter)]
    pub fn cited(&self) -> String {
        serde_json::to_string(&self.0.cited).unwrap_or_default()
    }

    #[wasm_bindgen(getter)]
    pub fn pictures(&self) -> usize {
        self.0.pictures.len()
    }

    pub fn picture(&self, at: usize) -> Option<Vec<u8>> {
        picture(&self.0.pictures, at)
    }

    pub fn media(&self, at: usize) -> Option<String> {
        media(self.0.pictures.get(at).map(|(kind, _)| *kind))
    }
}

#[wasm_bindgen]
pub struct Sheet(Begun);

#[wasm_bindgen]
impl Sheet {
    #[wasm_bindgen(getter)]
    pub fn html(&self) -> String {
        self.0.html.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn about(&self) -> String {
        serde_json::to_string(&self.0.about).unwrap_or_default()
    }

    #[wasm_bindgen(getter)]
    pub fn cited(&self) -> String {
        serde_json::to_string(&self.0.cited).unwrap_or_default()
    }

    #[wasm_bindgen(getter)]
    pub fn pictures(&self) -> usize {
        self.0.kinds.len()
    }

    pub fn media(&self, at: usize) -> Option<String> {
        media(self.0.kinds.get(at).copied())
    }

    pub fn rest(&mut self, rest: Vec<u8>) -> Result<Rest, JsError> {
        self.0
            .rest(rest)
            .map(Rest)
            .map_err(|unread| JsError::new(unread.word()))
    }
}

#[wasm_bindgen]
pub struct Rest(envelope::Rest);

#[wasm_bindgen]
impl Rest {
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.0.text.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn pictures(&self) -> usize {
        self.0.pictures.len()
    }

    pub fn picture(&self, at: usize) -> Option<Vec<u8>> {
        picture(&self.0.pictures, at)
    }
}

fn picture(pictures: &[(Kind, Zeroizing<Vec<u8>>)], at: usize) -> Option<Vec<u8>> {
    pictures.get(at).map(|(_, bytes)| bytes.to_vec())
}

fn media(kind: Option<Kind>) -> Option<String> {
    kind.map(|kind| kind.media().to_owned())
}

/// Opens the envelope, told of the keys taken back the server sent beside it, or says in one word why it would not open.
#[wasm_bindgen]
pub fn open(
    envelope: Vec<u8>,
    key: &str,
    revoked: Option<String>,
    limits: Option<String>,
) -> Result<Page, JsError> {
    shown(envelope, key, limits.as_deref(), revoked.as_deref())
        .map(Page)
        .map_err(|unread| JsError::new(unread.word()))
}

#[wasm_bindgen]
pub fn open_sheet(
    sheet: Vec<u8>,
    key: &str,
    revoked: Option<String>,
    limits: Option<String>,
) -> Result<Sheet, JsError> {
    begun(sheet, key, limits.as_deref(), revoked.as_deref())
        .map(Sheet)
        .map_err(|unread| JsError::new(unread.word()))
}

/// The proof a server's challenge asks for, as the JSON it takes in `Tisty-Work`.
#[wasm_bindgen]
pub fn solved(challenge: &str) -> Option<String> {
    worked::solved(challenge)
}

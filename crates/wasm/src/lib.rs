//! What the page that reads a link runs in the browser: the key in the link's `#` opens the envelope here, never on the server.

pub mod shown;
pub mod worked;

#[cfg(target_arch = "wasm32")]
mod browser;

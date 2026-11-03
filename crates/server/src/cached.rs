use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::store::{Doc, Sender};

/// The longest a read waits in the cache in front of the server: what a purge that failed can leave stale (decision 94).
pub const CACHED_AT_MOST: i64 = 60 * 60;

/// What a read may leave in the cache in front of the server: for how long, and the tags that empty it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cached {
    pub seconds: i64,
    pub tags: Vec<String>,
}

pub fn doc_tag(id: &str) -> String {
    format!("doc:{id}")
}

/// Every version a key sent, so taking the key back reaches the reads that name it.
pub fn sender_tag(by: &Sender) -> String {
    format!(
        "by:{}.{}",
        URL_SAFE_NO_PAD.encode(by.share),
        URL_SAFE_NO_PAD.encode(by.root)
    )
}

/// A read with no password and no share holding it or held by it may wait in the cache; it leaves well before the
/// document ends, so a read always reaches the server while there is still time to push the end back.
pub fn cached(doc: &Doc, by: Option<&Sender>, ends: i64, now: i64) -> Option<Cached> {
    let alone = doc.gate.is_none() && doc.holders.is_empty() && doc.holds.is_empty();
    let seconds = ((ends - now) / 2).min(CACHED_AT_MOST);
    (alone && seconds > 0).then(|| Cached {
        seconds,
        tags: std::iter::once(doc_tag(&doc.id))
            .chain(by.map(sender_tag))
            .collect(),
    })
}

#[cfg(test)]
#[path = "cached_test.rs"]
mod tests;

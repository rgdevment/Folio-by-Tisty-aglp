use serde::{Deserialize, Serialize};

use crate::moderation::Report;

/// What the server knows about one shared document, without a word of what it says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    /// The edit link's token, hashed: a stolen table hands nobody the power to write.
    pub edit: [u8; 32],
    /// The management link's token, hashed the same way.
    pub admin: [u8; 32],
    pub gate: Option<Gate>,
    /// The versions still kept, oldest first; the last is the one served.
    pub versions: Vec<Kept>,
    pub created: i64,
    /// When it last saw a person read it, its owner visit it, or a new version.
    pub active: i64,
    /// How long it may stay idle before it goes, never more than the server allows.
    pub idle: i64,
    /// When it goes unless something happens before: kept so a sweep can ask the store for it.
    pub ends: i64,
    pub paused: Option<i64>,
    /// When reports blocked it: no longer served, kept as evidence (decision 36).
    pub blocked: Option<i64>,
    /// Readers counted once a day each, never who they were (decision 47).
    pub reads: u64,
    /// Bumped on every save, so two writers never both win.
    pub revision: u64,
}

impl Doc {
    pub fn latest(&self) -> Option<u64> {
        self.versions.last().map(|kept| kept.version)
    }
}

/// One version and the digest of its envelope, which names it in the store, so two uploads of one version never overwrite each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Kept {
    pub version: u64,
    pub digest: [u8; 32],
}

/// The password a reader must say, kept as a slow digest and guarded against guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gate {
    pub salt: [u8; 16],
    pub digest: [u8; 32],
    pub missed: u32,
    pub locked_until: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the store failed: {0}")]
pub struct Fault(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Saved {
    Done,
    /// Someone saved first; the caller reads again and decides.
    Raced,
}

/// Where the server keeps what it serves: D1 and R2 on Workers, SQLite and S3 elsewhere.
// Workers runs one request per thread, so the futures need no Send bound, and leaving it out keeps D1 reachable.
#[allow(async_fn_in_trait)]
pub trait Store {
    async fn doc(&self, id: &str) -> Result<Option<Doc>, Fault>;
    /// Saves only if what is stored still has `revision`, or nothing is stored when it is None.
    async fn save(&self, doc: &Doc, revision: Option<u64>) -> Result<Saved, Fault>;
    async fn forget(&self, id: &str) -> Result<(), Fault>;
    async fn envelope(&self, id: &str, kept: &Kept) -> Result<Option<Vec<u8>>, Fault>;
    async fn keep(&self, id: &str, kept: &Kept, bytes: &[u8]) -> Result<(), Fault>;
    async fn drop_envelope(&self, id: &str, kept: &Kept) -> Result<(), Fault>;
    /// The ids of every document whose `ends` has passed.
    async fn ending(&self, now: i64) -> Result<Vec<String>, Fault>;
    /// Atomically adds `by` to a counter that lapses at `until` and says what it holds now, or requests together slip past.
    async fn count(&self, key: &str, by: u64, until: i64, now: i64) -> Result<u64, Fault>;
    /// Marks `key` until a moment, as a block or a proof already spent.
    async fn hold(&self, key: &str, until: i64) -> Result<(), Fault>;
    async fn held(&self, key: &str, now: i64) -> Result<Option<i64>, Fault>;
    async fn file(&self, report: &Report) -> Result<(), Fault>;
    async fn reports(&self, id: &str, now: i64) -> Result<Vec<Report>, Fault>;
    /// Lets go of every counter, mark and report whose time has passed.
    async fn lapse(&self, now: i64) -> Result<(), Fault>;
}

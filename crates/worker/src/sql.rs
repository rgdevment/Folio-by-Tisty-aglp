//! The statements the Worker runs on D1, kept apart so they are tested on SQLite where it is built.

pub const DOC: &str = "SELECT body FROM docs WHERE id = ?1";

/// A first save, which a document already there turns away.
pub const INSERT_DOC: &str = "INSERT INTO docs (id, revision, ends, body) VALUES (?1, ?2, ?3, ?4) \
     ON CONFLICT (id) DO NOTHING";

/// A save that lands only on the revision it was decided on.
pub const UPDATE_DOC: &str =
    "UPDATE docs SET revision = ?2, ends = ?3, body = ?4 WHERE id = ?1 AND revision = ?5";

pub const FORGET: &str = "DELETE FROM docs WHERE id = ?1";

pub const ENDING: &str = "SELECT id FROM docs WHERE ends < ?1 ORDER BY ends, id LIMIT ?2";

/// One statement, so requests arriving together each see their own count.
pub const COUNT: &str = "INSERT INTO counters (key, value, until) VALUES (?1, ?2, ?3) \
     ON CONFLICT (key) DO UPDATE SET \
       value = CASE WHEN until < ?4 THEN excluded.value ELSE value + excluded.value END, \
       until = CASE WHEN until < ?4 THEN excluded.until ELSE until END \
     RETURNING value";

pub const HOLD: &str = "INSERT INTO holds (key, until) VALUES (?1, ?2) \
     ON CONFLICT (key) DO UPDATE SET until = excluded.until";

/// Writes only when nothing holds `key` now, so a mark already there costs no write.
pub const MARK: &str = "INSERT INTO holds (key, until) VALUES (?1, ?2) \
     ON CONFLICT (key) DO UPDATE SET until = excluded.until WHERE holds.until < ?3";

pub const HELD: &str = "SELECT until FROM holds WHERE key = ?1 AND until >= ?2";

pub const FILE: &str = "INSERT INTO reports (id, until, body) VALUES (?1, ?2, ?3)";

pub const REPORTS: &str = "SELECT body FROM reports WHERE id = ?1 AND until >= ?2 ORDER BY rowid";

/// The first word a root said on a key stands; the same one said again writes nothing.
pub const REVOKE: &str = "INSERT INTO revocations (share, root, body) VALUES (?1, ?2, ?3) ON CONFLICT (share, root) DO NOTHING";

pub const REVOCATION: &str = "SELECT body FROM revocations WHERE share = ?1 AND root = ?2";

/// A few thousand rows of each at a time, so one run stays inside what D1 lets a query take.
pub const LAPSE: [&str; 3] = [
    "DELETE FROM counters WHERE rowid IN (SELECT rowid FROM counters WHERE until < ?1 LIMIT 5000)",
    "DELETE FROM holds WHERE rowid IN (SELECT rowid FROM holds WHERE until < ?1 LIMIT 5000)",
    "DELETE FROM reports WHERE rowid IN (SELECT rowid FROM reports WHERE until < ?1 LIMIT 5000)",
];

#[cfg(test)]
#[path = "sql_test.rs"]
mod tests;

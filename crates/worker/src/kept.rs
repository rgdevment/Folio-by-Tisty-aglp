//! How the Worker names and reads back what it keeps, apart from Workers so it is tested where it is built.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use tisty_share_server::store::Kept;

/// D1 hands each row back as an object named by its columns, so these fields are the columns the queries name.
#[derive(Debug, Deserialize)]
pub struct Body {
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct Id {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct Value {
    pub value: u64,
}

#[derive(Debug, Deserialize)]
pub struct Until {
    pub until: i64,
}

/// What the rate-limiting binding allows, as wrangler.toml sets it: so many in each period of seconds.
pub const LIMITER_PERIOD: i64 = 60;
pub const READS_IN_A_PERIOD: u64 = 20;
pub const POLLS_IN_A_PERIOD: u64 = 60;

pub fn envelope_key(id: &str, kept: &Kept) -> String {
    format!(
        "{}{}.{}",
        envelopes_of(id),
        kept.version,
        URL_SAFE_NO_PAD.encode(kept.digest)
    )
}

/// What every envelope of one document starts with; the slash keeps `abc` from reaching `abcd`'s.
pub fn envelopes_of(id: &str) -> String {
    format!("{id}/")
}

/// The server's secret, kept among the Worker's secrets as 64 hexadecimal digits.
pub fn secret_from_hex(said: &str) -> Option<[u8; 32]> {
    let digits = said.as_bytes();
    if digits.len() != 64 {
        return None;
    }
    let mut secret = [0u8; 32];
    for (byte, [high, low]) in secret.iter_mut().zip(digits.as_chunks::<2>().0) {
        let high = char::from(*high).to_digit(16)?;
        let low = char::from(*low).to_digit(16)?;
        *byte = u8::try_from(high * 16 + low).ok()?;
    }
    Some(secret)
}

#[cfg(test)]
#[path = "kept_test.rs"]
mod tests;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::store::Gate;

/// Short enough to say aloud, long enough that guessing a live one is hopeless: 62^8 is about 2^47.
pub const ID_LEN: usize = 8;
const ID_ALPHABET: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN: &[u8] = b"tisty-share.token.v1\0";
const GATE: &[u8] = b"tisty-share.gate.v1\0";

/// Whatever the host draws its randomness from: Workers' crypto, the system's, or a fixed list in a test.
pub trait Randomness {
    /// False when there is none to give, so nothing is minted from zeros.
    fn fill(&mut self, into: &mut [u8]) -> bool;
}

/// Each character drawn by rejection, so no letter of the id comes up more often than another.
pub fn minted_id(random: &mut impl Randomness) -> Option<String> {
    let mut id = String::with_capacity(ID_LEN);
    let mut byte = [0u8; 1];
    while id.len() < ID_LEN {
        if !random.fill(&mut byte) {
            return None;
        }
        // 248 is the largest multiple of 62 below 256.
        if byte[0] < 248 {
            id.push(char::from(ID_ALPHABET[usize::from(byte[0] % 62)]));
        }
    }
    Some(id)
}

/// 256 bits, so the token alone is the permission and its hash needs no salt.
pub fn minted_token(random: &mut impl Randomness) -> Option<Zeroizing<String>> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    random
        .fill(bytes.as_mut())
        .then(|| Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref())))
}

pub fn hashed(token: &str) -> [u8; 32] {
    let mut over = Sha256::new();
    over.update(TOKEN);
    over.update(token.as_bytes());
    over.finalize().into()
}

/// How slow the password's digest is; the Worker's CPU allowance decides how far it can go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slowness {
    pub log_n: u8,
    pub r: u32,
}

impl Default for Slowness {
    fn default() -> Self {
        Self { log_n: 12, r: 8 }
    }
}

pub fn gate(password: &str, salt: [u8; 16], slow: Slowness) -> Option<Gate> {
    Some(Gate {
        salt,
        digest: digest(password, &salt, slow)?,
        missed: 0,
        locked_until: None,
    })
}

pub fn opens(gate: &Gate, password: &str, slow: Slowness) -> bool {
    digest(password, &gate.salt, slow).is_some_and(|said| said == gate.digest)
}

fn digest(password: &str, salt: &[u8; 16], slow: Slowness) -> Option<[u8; 32]> {
    let params = scrypt::Params::new(slow.log_n, slow.r, 1).ok()?;
    let mut said = Zeroizing::new(GATE.to_vec());
    said.extend_from_slice(password.as_bytes());
    let mut out = [0u8; 32];
    scrypt::scrypt(&said, salt, &params, &mut out).ok()?;
    Some(out)
}

#[cfg(test)]
#[path = "keys_test.rs"]
mod tests;

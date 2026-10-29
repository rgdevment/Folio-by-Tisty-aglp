use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const WORK: &[u8] = b"tisty-share.work.v1\0";
/// Past this many leading zero bits nobody could finish, so a server asking for more is refused rather than obeyed.
pub const BITS_AT_MOST: u8 = 32;

/// What a server asks to be worked before it takes something: a seed only it could have signed, and how hard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Challenge {
    /// Drawn fresh for every challenge, so two callers asking at once never share one to spend.
    pub salt: String,
    pub seed: String,
    pub bits: u8,
    pub expires: i64,
}

/// The challenge as it was given, and the number that answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    pub challenge: Challenge,
    pub nonce: u64,
}

/// Counts up until the hash starts with enough zeros; a browser and a Tisty pay the same.
pub fn solve(challenge: &Challenge) -> Option<Proof> {
    if challenge.bits > BITS_AT_MOST {
        return None;
    }
    (0..=u64::MAX)
        .find(|nonce| meets(challenge, *nonce))
        .map(|nonce| Proof {
            challenge: challenge.clone(),
            nonce,
        })
}

pub fn meets(challenge: &Challenge, nonce: u64) -> bool {
    let mut over = Sha256::new();
    over.update(WORK);
    over.update(challenge.seed.as_bytes());
    over.update(nonce.to_be_bytes());
    leading_zeros(&over.finalize()) >= u32::from(challenge.bits)
}

fn leading_zeros(hash: &[u8]) -> u32 {
    let mut zeros = 0;
    for byte in hash {
        zeros += byte.leading_zeros();
        if *byte != 0 {
            break;
        }
    }
    zeros
}

#[cfg(test)]
#[path = "work_test.rs"]
mod tests;

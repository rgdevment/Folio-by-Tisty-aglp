//! What testing a server on the store in memory takes, shared with the hosts that wrap it.

use std::pin::pin;
use std::task::{Context, Poll, Waker};

use tisty_share_proto::identity::{Certificate, Revocation, Root, ShareKey};

use crate::keys::Randomness;

/// When the tests' writer signs: any moment does, as long as it is the same one.
pub const SIGNED_AT: jiff::Timestamp = jiff::Timestamp::UNIX_EPOCH;

/// A machine's key and the certificate its person gave it, since the server takes nothing unsigned.
pub fn vouched() -> (ShareKey, Certificate) {
    let machine = ShareKey::from_bytes(&[2; 32]);
    let certificate =
        Root::from_bytes(&[1; 32]).certify(&machine.public(), jiff::Timestamp::UNIX_EPOCH);
    (machine, certificate)
}

/// The same person taking that machine's key back.
pub fn taken_back(at: i64) -> Revocation {
    let (machine, _) = vouched();
    let at = jiff::Timestamp::from_second(at).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    Root::from_bytes(&[1; 32]).revoke(&machine.public(), at)
}

/// The memory store never waits, so one poll finishes any of the server's work.
pub fn done<T>(work: impl Future<Output = T>) -> T {
    match pin!(work).poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(said) => said,
        Poll::Pending => panic!("the memory store never waits"),
    }
}

/// Counts up, so every id and token in a test is different and the same run after run.
pub struct Counting(pub u8);

impl Randomness for Counting {
    fn fill(&mut self, into: &mut [u8]) -> bool {
        for one in into {
            self.0 = self.0.wrapping_add(1) % 248;
            *one = self.0;
        }
        true
    }
}

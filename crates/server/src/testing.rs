//! What testing a server on the store in memory takes, shared with the hosts that wrap it.

use std::pin::pin;
use std::task::{Context, Poll, Waker};

use crate::keys::Randomness;

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

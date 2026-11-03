//! Folio's server, blind to HTTP and to where it runs: a host lends it a store, randomness and the time.

pub mod folio;
pub mod guard;
mod guessing;
pub mod holding;
pub mod keys;
pub mod memory;
pub mod moderation;
pub mod revoking;
pub mod store;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

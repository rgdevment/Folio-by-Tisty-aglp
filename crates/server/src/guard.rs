use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tisty_share_proto::work::{self, Challenge, Proof};

use crate::share::{Policy, Refused};
use crate::store::{Fault, Store};

const HOUR: i64 = 60 * 60;
const DAY: i64 = 24 * HOUR;
const CHALLENGE: &[u8] = b"tisty-share.challenge.v1\0";
const WHO_TODAY: &[u8] = b"tisty-share.who.day.v1\0";
const WHO: &[u8] = b"tisty-share.who.v1\0";

/// What a caller is about to do, each with its own hourly allowance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Reserve,
    Upload,
    Read,
    /// A Tisty asking whether a document it follows changed.
    Poll,
    Report,
}

impl Act {
    fn name(self) -> &'static str {
        match self {
            Act::Reserve => "reserve",
            Act::Upload => "upload",
            Act::Read => "read",
            Act::Poll => "poll",
            Act::Report => "report",
        }
    }

    /// A network is many readers behind one address, so reading too much only waits out the hour.
    fn escalates(self) -> bool {
        !matches!(self, Act::Read | Act::Poll)
    }
}

/// How many of each a caller may do in an hour, how much it may store in a day, and how long it waits when it overdoes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allowance {
    pub reserves: u64,
    pub uploads: u64,
    pub reads: u64,
    pub polls: u64,
    pub reports: u64,
    pub documents_a_day: u64,
    pub bytes_a_day: u64,
    /// The first time it is too much, the second and every one after, within a week.
    pub waits: [i64; 3],
}

impl Default for Allowance {
    /// Placeholders until the numbers are measured; each server sets its own.
    fn default() -> Self {
        Self {
            reserves: 20,
            uploads: 60,
            reads: 600,
            polls: 3_600,
            reports: 10,
            documents_a_day: 50,
            bytes_a_day: 50 * 1024 * 1024,
            waits: [HOUR, DAY, 7 * DAY],
        }
    }
}

impl Allowance {
    fn per_hour(&self, act: Act) -> u64 {
        match act {
            Act::Reserve => self.reserves,
            Act::Upload => self.uploads,
            Act::Read => self.reads,
            Act::Poll => self.polls,
            Act::Report => self.reports,
        }
    }
}

/// How much work each step costs, in leading zero bits of a hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Work {
    pub reserve: u8,
    pub upload: u8,
    /// Added for every megabyte an upload carries, so a heavy one costs more than a note (decision 33).
    pub per_megabyte: u8,
    pub report: u8,
    pub lasts: i64,
}

impl Default for Work {
    fn default() -> Self {
        Self {
            reserve: 16,
            upload: 14,
            per_megabyte: 2,
            report: 18,
            lasts: 10 * 60,
        }
    }
}

impl Work {
    pub fn for_upload(&self, bytes: u64) -> u8 {
        let megabytes = bytes.div_ceil(1024 * 1024);
        let added = megabytes.saturating_mul(u64::from(self.per_megabyte));
        let bits = u64::from(self.upload).saturating_add(added);
        bits.min(u64::from(work::BITS_AT_MOST)) as u8
    }
}

/// A seed only this server could have signed, bound to what it is for, so no proof answers for something else.
pub fn challenge(
    secret: &[u8; 32],
    bound: &[u8],
    salt: [u8; 16],
    bits: u8,
    expires: i64,
) -> Challenge {
    let salt = URL_SAFE_NO_PAD.encode(salt);
    Challenge {
        seed: seed(secret, bound, &salt, bits, expires),
        salt,
        bits,
        expires,
    }
}

pub fn checked(
    secret: &[u8; 32],
    bound: &[u8],
    proof: &Proof,
    needed: u8,
    now: i64,
) -> Result<(), Refused> {
    let asked = &proof.challenge;
    let signed = seed(secret, bound, &asked.salt, asked.bits, asked.expires) == asked.seed;
    if !signed || asked.expires < now || asked.bits < needed {
        return Err(Refused::WorkRefused);
    }
    if !work::meets(asked, proof.nonce) {
        return Err(Refused::WorkRefused);
    }
    Ok(())
}

fn seed(secret: &[u8; 32], bound: &[u8], salt: &str, bits: u8, expires: i64) -> String {
    // Each part says its length, so no bound and salt run together into another pair.
    let lengths = [bound.len() as u64, salt.len() as u64].map(u64::to_be_bytes);
    let said = keyed(
        secret,
        &[
            CHALLENGE,
            &lengths[0],
            bound,
            &lengths[1],
            salt.as_bytes(),
            &[bits],
            &expires.to_be_bytes(),
        ],
    );
    URL_SAFE_NO_PAD.encode(said)
}

/// An IPv6 caller is one /64, so a machine cannot step around a limit by changing its last bits.
fn network(ip: IpAddr) -> Vec<u8> {
    match ip {
        IpAddr::V4(four) => four.octets().to_vec(),
        IpAddr::V6(six) => match six.to_ipv4_mapped() {
            Some(four) => four.octets().to_vec(),
            None => six.octets()[..8].to_vec(),
        },
    }
}

/// Today's name for a caller: counters a day apart can never be told to be the same person.
pub fn today(secret: &[u8; 32], ip: IpAddr, now: i64) -> String {
    let day = now.div_euclid(DAY);
    hex(&keyed(
        secret,
        &[WHO_TODAY, &day.to_be_bytes(), &network(ip)],
    ))
}

/// A name that holds across days but not past `period`, kept only while a wait or a report needs it (decisions 41 and 42).
pub fn lasting(secret: &[u8; 32], ip: IpAddr, now: i64, period: i64) -> String {
    let epoch = now.div_euclid(period.max(1));
    hex(&keyed(secret, &[WHO, &epoch.to_be_bytes(), &network(ip)]))
}

/// Refused while the caller waits out a block, and a step past its allowance earns the next, longer wait.
pub async fn admit<S: Store>(
    store: &S,
    policy: &Policy,
    secret: &[u8; 32],
    ip: IpAddr,
    act: Act,
    now: i64,
) -> Result<(), Refused> {
    let who = lasting(secret, ip, now, policy.evidence);
    if let Some(until) = store.held(&format!("wait:{who}"), now).await? {
        return Err(Refused::Slow { until });
    }
    let allowance = policy.allowance.per_hour(act);
    let Some(until) = store
        .within(act, &today(secret, ip, now), allowance, now)
        .await?
    else {
        return Ok(());
    };
    if !act.escalates() {
        return Err(Refused::Slow { until });
    }
    Err(overdone(store, policy, &who, now).await?)
}

/// The store's own count of a step this hour: past `allowance`, the hour's end, when the caller may try again.
pub async fn counted_within<S: Store + ?Sized>(
    store: &S,
    act: Act,
    who: &str,
    allowance: u64,
    now: i64,
) -> Result<Option<i64>, Fault> {
    let hour = now.div_euclid(HOUR);
    let next_hour = (hour + 1) * HOUR;
    let key = format!("rate:{}:{who}:{hour}", act.name());
    let done = store.count(&key, 1, next_hour, now).await?;
    Ok((done > allowance).then_some(next_hour))
}

/// What a caller stores in a day; a spent day waits for the next, counting nothing refused and growing no wait.
pub async fn spend<S: Store>(
    store: &S,
    policy: &Policy,
    secret: &[u8; 32],
    ip: IpAddr,
    documents: u64,
    bytes: u64,
    now: i64,
) -> Result<(), Refused> {
    affords(store, policy, secret, ip, documents, bytes, now).await?;
    charge(store, secret, ip, documents, bytes, now).await
}

/// Whether the day still has room for this, counting nothing yet.
pub async fn affords<S: Store>(
    store: &S,
    policy: &Policy,
    secret: &[u8; 32],
    ip: IpAddr,
    documents: u64,
    bytes: u64,
    now: i64,
) -> Result<(), Refused> {
    let (made, sent, until) = day_keys(secret, ip, now);
    let allowance = &policy.allowance;
    let made_so_far = store.count(&made, 0, until, now).await?;
    let sent_so_far = store.count(&sent, 0, until, now).await?;
    if made_so_far.saturating_add(documents) > allowance.documents_a_day
        || sent_so_far.saturating_add(bytes) > allowance.bytes_a_day
    {
        return Err(Refused::Slow { until });
    }
    Ok(())
}

/// Counts against the day what was kept, once it was.
pub async fn charge<S: Store>(
    store: &S,
    secret: &[u8; 32],
    ip: IpAddr,
    documents: u64,
    bytes: u64,
    now: i64,
) -> Result<(), Refused> {
    let (made, sent, until) = day_keys(secret, ip, now);
    store.count(&made, documents, until, now).await?;
    store.count(&sent, bytes, until, now).await?;
    Ok(())
}

fn day_keys(secret: &[u8; 32], ip: IpAddr, now: i64) -> (String, String, i64) {
    let day = now.div_euclid(DAY);
    let who = today(secret, ip, now);
    (
        format!("documents:{who}:{day}"),
        format!("bytes:{who}:{day}"),
        (day + 1) * DAY,
    )
}

async fn overdone<S: Store>(
    store: &S,
    policy: &Policy,
    who: &str,
    now: i64,
) -> Result<Refused, Refused> {
    let strikes = store
        .count(&format!("strikes:{who}"), 1, now + 7 * DAY, now)
        .await?;
    let waits = &policy.allowance.waits;
    let wait = waits[usize::try_from(strikes - 1)
        .unwrap_or(usize::MAX)
        .min(waits.len() - 1)];
    let until = now + wait;
    store.hold(&format!("wait:{who}"), until).await?;
    Ok(Refused::Slow { until })
}

/// HMAC pads a key shorter than its block with zeros, so padding it here builds one that cannot fail.
fn keyed(secret: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut block = hmac::digest::Key::<Hmac<Sha256>>::default();
    block[..secret.len()].copy_from_slice(secret);
    let mut over = <Hmac<Sha256> as KeyInit>::new(&block);
    parts.iter().for_each(|part| over.update(part));
    over.finalize().into_bytes().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[path = "guard_test.rs"]
mod tests;

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use tisty_share_proto::envelope::{Envelope, Refused as Unread};
use tisty_share_proto::identity::{Revocation, Verdict};
use tisty_share_proto::limits::Limits;
use tisty_share_proto::work::{Challenge, Proof};
use zeroize::Zeroizing;

use crate::guard::{self, Act, Allowance, Work};
use crate::keys::{self, Randomness, Slowness};
use crate::store::{Doc, Fault, Kept, Saved, Sender, Store};

const DAY: i64 = 24 * 60 * 60;
/// A read writes down activity at most this often: days decide an expiry, and every write costs a store.
const ACTIVITY_GRAIN: i64 = 60 * 60;

/// The numbers a server runs on, all of them its own to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub limits: Limits,
    /// Versions kept of each document, so an owner can still see what someone else changed.
    pub versions: usize,
    /// Seconds a document may stay without activity before it goes.
    pub idle: i64,
    /// Seconds a document stays paused in its owner's trash before it goes.
    pub trash: i64,
    /// Seconds a reserved id waits for its first version.
    pub reserved: i64,
    /// Wrong passwords one network may say to one document in `locked` seconds; past them, that network waits the rest.
    pub misses: u64,
    /// The same for a whole IPv6 /48, which holds 65,536 networks of its own.
    pub misses_wide: u64,
    pub locked: i64,
    /// Wrong passwords a document hears in a day from everywhere before every try costs work (decision 76).
    pub guessed: u64,
    /// Past these in a day, every network and block gets a fifth of its tries, so spreading out buys a guesser little.
    pub guessed_most: u64,
    pub slowness: Slowness,
    pub allowance: Allowance,
    pub work: Work,
    /// Reports from this many places block a document (decision 36).
    pub reports_to_block: usize,
    /// Documents one sweep takes at most, so a run stays inside what its host allows one run to do.
    pub sweep: usize,
    /// Seconds a report and a blocked document are kept as evidence (decision 42).
    pub evidence: i64,
}

impl Default for Policy {
    /// Decisions 33, 36, 42, 49 and 51; what is not decided yet is a placeholder.
    fn default() -> Self {
        Self {
            limits: Limits::default(),
            versions: 5,
            idle: 30 * DAY,
            trash: 30 * DAY,
            reserved: 60 * 60,
            misses: 5,
            misses_wide: 20,
            locked: 15 * 60,
            guessed: 50,
            guessed_most: 1_000,
            slowness: Slowness::default(),
            allowance: Allowance::default(),
            work: Work::default(),
            reports_to_block: 3,
            sweep: 15,
            evidence: 90 * DAY,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("there is no such document")]
    Missing,
    /// It existed and is gone: expired, deleted or emptied from the trash.
    #[error("this document is no longer shared")]
    Gone,
    /// Reserved, and its first version is not there yet: the link works once the upload ends.
    #[error("this document is not uploaded yet")]
    Unwritten,
    #[error("its owner put this document away for now")]
    Paused,
    #[error("reports blocked this document")]
    Blocked,
    #[error("this link does not give that permission")]
    Forbidden,
    #[error("this document asks for its password")]
    PasswordAsked,
    #[error("that is not its password")]
    PasswordWrong,
    /// Too many wrong ones from this place: only it waits, never the document's other readers (decision 76).
    #[error("too many wrong passwords; try again later")]
    PasswordLocked { until: i64 },
    /// Guessed at from everywhere today, so a password is weighed only with a proof of work beside it.
    #[error("this document asks for work with its password")]
    WorkAsked,
    /// Someone else uploaded first; Tisty shows both and lets the person choose.
    #[error("there is a newer version than the one this was written on")]
    Behind { latest: Option<u64> },
    #[error("this envelope is not for this document")]
    Misaddressed,
    #[error("the envelope was refused: {0}")]
    Envelope(Unread),
    /// Unsigned, or signed by a key that does not hold: the key is the only identity there is (decision 71).
    #[error("the envelope is not signed by a key that holds")]
    Unsigned,
    /// The work asked for is missing, short, spent, expired or not this server's.
    #[error("the work asked for was not done")]
    WorkRefused,
    /// Past its allowance, the caller waits until then (decision 10).
    #[error("too much at once; try again later")]
    Slow { until: i64 },
    #[error("this place already reported this document")]
    Reported,
    #[error("that is longer than a report takes")]
    TooLong,
    #[error("no free id could be found; try again")]
    Crowded,
    #[error("there was no randomness to mint with")]
    NoRandomness,
    #[error("{0}")]
    Store(#[from] Fault),
}

/// The three links of a new document, handed back once: the server keeps only their hashes.
#[derive(Debug)]
pub struct Reserved {
    pub id: String,
    pub edit: Zeroizing<String>,
    pub admin: Zeroizing<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Served {
    pub version: u64,
    pub envelope: Vec<u8>,
    pub facts: Facts,
    /// What took back the key that sent it, so the reader is told rather than shown it as holding.
    pub revoked: Vec<Revocation>,
}

/// What a reader is told beside the words: nothing the server does not already hold in the clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub shared: i64,
    pub written: Option<i64>,
    pub ends: i64,
    pub gated: bool,
}

impl Facts {
    fn of(doc: &Doc) -> Self {
        Self {
            shared: doc.created,
            written: doc.written,
            ends: doc.ends,
            gated: doc.gate.is_some(),
        }
    }
}

/// What a management link can do.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "do", content = "with", rename_all = "snake_case")]
pub enum Manage {
    /// The owner looked in on it, which counts as activity.
    Visit,
    /// A new password, or none.
    Password(Option<String>),
    /// A shorter idle time than the server's, in seconds.
    Idle(i64),
    Pause,
    Restore,
    Delete,
}

/// What a sweep did: how many documents went, and those it could not take, for the host to tell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Swept {
    pub gone: usize,
    /// Those that would not go, with why; each waits a day before it is tried again.
    pub stuck: Vec<(String, Fault)>,
    /// Why counters, marks and reports past their time could not go, if they could not.
    pub unlapsed: Option<Fault>,
}

/// What an owner sees of a document on its card in Tisty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Info {
    pub latest: Option<u64>,
    pub reads: u64,
    pub ends: i64,
    pub paused: bool,
    pub blocked: bool,
    pub gated: bool,
}

/// What a caller asks to work for, so the proof answers for that and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask<'a> {
    Reserve,
    /// The envelope's digest and size, worked out by the Tisty that sealed it.
    Upload {
        id: &'a str,
        digest: [u8; 32],
        bytes: u64,
    },
    Report {
        id: &'a str,
    },
    /// A password said to a document guessed at from everywhere today.
    Password {
        id: &'a str,
    },
}

impl Ask<'_> {
    pub(crate) fn bound(&self) -> Vec<u8> {
        match self {
            Ask::Reserve => b"reserve".to_vec(),
            Ask::Upload { id, digest, .. } => {
                [b"upload:".as_slice(), id.as_bytes(), digest].concat()
            }
            Ask::Report { id } => [b"report:".as_slice(), id.as_bytes()].concat(),
            Ask::Password { id } => [b"password:".as_slice(), id.as_bytes()].concat(),
        }
    }
}

pub struct Share<S, R> {
    pub store: S,
    pub random: R,
    pub policy: Policy,
    /// Signs challenges and names callers; the host keeps it among its secrets (decision 19).
    pub(crate) secret: Zeroizing<[u8; 32]>,
}

impl<S: Store, R: Randomness> Share<S, R> {
    pub fn new(store: S, random: R, policy: Policy, secret: [u8; 32]) -> Self {
        Self {
            store,
            random,
            policy,
            secret: Zeroizing::new(secret),
        }
    }

    /// The work a step costs, signed so only this server's challenges are taken.
    pub async fn challenge(
        &mut self,
        ask: Ask<'_>,
        caller: IpAddr,
        now: i64,
    ) -> Result<Challenge, Refused> {
        let work = self.policy.work;
        let bits = match ask {
            Ask::Reserve => work.reserve,
            Ask::Upload { bytes, .. } => work.for_upload(bytes),
            Ask::Report { .. } => work.report,
            Ask::Password { id } => {
                // Counted as a read, and only for a document a reader could open with a password, so no other id costs a look.
                self.admit(caller, Act::Read, now).await?;
                let doc = self.live(id, now).await?;
                open_to_read(&doc)?;
                if doc.gate.is_none() {
                    return Err(Refused::Forbidden);
                }
                u8::max(self.password_work(id, now).await?, work.password)
            }
        };
        let mut salt = [0u8; 16];
        if !self.random.fill(&mut salt) {
            return Err(Refused::NoRandomness);
        }
        Ok(guard::challenge(
            &self.secret,
            &ask.bound(),
            salt,
            bits,
            now + work.lasts,
        ))
    }

    /// The id comes first, since a Tisty seals the envelope for that id and signs it.
    pub async fn reserve(
        &mut self,
        caller: IpAddr,
        proof: &Proof,
        now: i64,
    ) -> Result<Reserved, Refused> {
        self.admit(caller, Act::Reserve, now).await?;
        let needed = self.policy.work.reserve;
        self.worked(&Ask::Reserve, proof, needed, now).await?;
        guard::spend(&self.store, &self.policy, &self.secret, caller, 1, 0, now).await?;
        let edit = keys::minted_token(&mut self.random).ok_or(Refused::NoRandomness)?;
        let admin = keys::minted_token(&mut self.random).ok_or(Refused::NoRandomness)?;
        for _ in 0..8 {
            let id = keys::minted_id(&mut self.random).ok_or(Refused::NoRandomness)?;
            let doc = Doc {
                id: id.clone(),
                edit: keys::hashed(&edit),
                admin: keys::hashed(&admin),
                gate: None,
                versions: Vec::new(),
                created: now,
                active: now,
                idle: self.policy.idle,
                ends: now + self.policy.reserved,
                paused: None,
                blocked: None,
                reads: 0,
                written: None,
                revision: 0,
            };
            if self.store.save(&doc, None).await? == Saved::Done {
                return Ok(Reserved { id, edit, admin });
            }
        }
        Err(Refused::Crowded)
    }

    /// Takes a version only if it was written on the latest one, so no change lands over another unseen.
    pub async fn upload(
        &mut self,
        id: &str,
        edit: &str,
        bytes: Vec<u8>,
        caller: IpAddr,
        proof: &Proof,
        now: i64,
    ) -> Result<u64, Refused> {
        self.admit(caller, Act::Upload, now).await?;
        let mut doc = self.live(id, now).await?;
        if keys::hashed(edit) != doc.edit {
            return Err(Refused::Forbidden);
        }
        // A blocked document is evidence, so not even its owner writes over it.
        open_to_read(&doc)?;
        let size = bytes.len() as u64;
        let envelope = Envelope::read(bytes, &self.policy.limits).map_err(Refused::Envelope)?;
        let ask = Ask::Upload {
            id,
            digest: envelope.digest(),
            bytes: size,
        };
        let needed = self.policy.work.for_upload(size);
        self.worked(&ask, proof, needed, now).await?;
        let manifest = envelope.manifest();
        if manifest.id != doc.id {
            return Err(Refused::Misaddressed);
        }
        let by = envelope.sender_vouched().map(|vouched| Sender {
            share: vouched.share.to_bytes(),
            root: vouched.person.to_bytes(),
        });
        let revoked = self.revoked(by.as_ref()).await?;
        if !matches!(envelope.sender(&revoked), Some(Verdict::Holds { .. })) {
            return Err(Refused::Unsigned);
        }
        let latest = doc.latest();
        if manifest.from != latest || manifest.version != latest.map_or(1, |one| one + 1) {
            return Err(Refused::Behind { latest });
        }
        // Only what was kept is counted against the day, so a store that fails costs the caller nothing.
        guard::affords(
            &self.store,
            &self.policy,
            &self.secret,
            caller,
            0,
            size,
            now,
        )
        .await?;
        let kept = Kept {
            version: manifest.version,
            digest: envelope.digest(),
            by,
        };
        self.store.keep(id, &kept, envelope.into_bytes()).await?;
        // A reserved id may wait an hour for its first version, and the reader is told when it was shared, not reserved.
        if latest.is_none() {
            doc.created = now;
        }
        doc.versions.push(kept);
        doc.written = Some(now);
        let dropped: Vec<Kept> = doc
            .versions
            .drain(..doc.versions.len().saturating_sub(self.policy.versions))
            .collect();
        touched(&mut doc, now);
        if let Err(lost) = self.saved(&mut doc).await {
            // The race was lost, so what was kept for it is nobody's and goes.
            self.store.drop_envelope(id, &kept).await?;
            return Err(lost);
        }
        guard::charge(&self.store, &self.secret, caller, 0, size, now).await?;
        for old in &dropped {
            self.store.drop_envelope(id, old).await?;
        }
        Ok(kept.version)
    }

    /// What a reader gets: only ever the latest version, so nobody is served one already replaced.
    pub async fn read(
        &mut self,
        id: &str,
        password: Option<&str>,
        proof: Option<&Proof>,
        caller: IpAddr,
        now: i64,
    ) -> Result<Served, Refused> {
        self.admit(caller, Act::Read, now).await?;
        let mut doc = self.live(id, now).await?;
        open_to_read(&doc)?;
        let kept = *doc.versions.last().ok_or(Refused::Unwritten)?;
        self.let_in(&doc, password, proof, caller, now).await?;
        let envelope = self
            .store
            .envelope(id, &kept)
            .await?
            .ok_or_else(|| lost(id, &kept))?;
        let new_reader = self.first_read_today(id, caller, now).await?;
        if new_reader {
            doc.reads += 1;
        }
        if new_reader || now - doc.active >= ACTIVITY_GRAIN {
            touched(&mut doc, now);
            // Another reader saving the same activity first loses nothing, so a race is no refusal.
            match self.saved(&mut doc).await {
                Ok(()) | Err(Refused::Behind { .. }) => {}
                Err(other) => return Err(other),
            }
        }
        Ok(Served {
            version: kept.version,
            envelope,
            facts: Facts::of(&doc),
            revoked: self.revoked(kept.by.as_ref()).await?,
        })
    }

    /// The latest version's number, for a Tisty looking for changes; asking is not activity (decision 50).
    pub async fn latest(&self, id: &str, caller: IpAddr, now: i64) -> Result<Option<u64>, Refused> {
        self.admit(caller, Act::Poll, now).await?;
        let doc = self.live(id, now).await?;
        open_to_read(&doc)?;
        Ok(doc.latest())
    }

    /// An earlier version, for the link that edits or manages, so a change can be seen before it is chosen.
    pub async fn version(
        &self,
        id: &str,
        token: &str,
        version: u64,
        now: i64,
    ) -> Result<Served, Refused> {
        let doc = self.live(id, now).await?;
        open_to_read(&doc)?;
        let hash = keys::hashed(token);
        if hash != doc.edit && hash != doc.admin {
            return Err(Refused::Forbidden);
        }
        let kept = doc
            .versions
            .iter()
            .find(|kept| kept.version == version)
            .ok_or(Refused::Missing)?;
        let envelope = self
            .store
            .envelope(id, kept)
            .await?
            .ok_or_else(|| lost(id, kept))?;
        Ok(Served {
            version,
            envelope,
            facts: Facts::of(&doc),
            revoked: self.revoked(kept.by.as_ref()).await?,
        })
    }

    pub async fn info(&self, id: &str, admin: &str, now: i64) -> Result<Info, Refused> {
        let doc = self.owned(id, admin, now).await?;
        Ok(Info {
            latest: doc.latest(),
            reads: doc.reads,
            ends: doc.ends,
            paused: doc.paused.is_some(),
            blocked: doc.blocked.is_some(),
            gated: doc.gate.is_some(),
        })
    }

    pub async fn manage(
        &mut self,
        id: &str,
        admin: &str,
        what: Manage,
        now: i64,
    ) -> Result<(), Refused> {
        let mut doc = self.owned(id, admin, now).await?;
        // Blocked, a document is evidence: only the owner's visit still counts (decision 36).
        if doc.blocked.is_some() && what != Manage::Visit {
            return Err(Refused::Blocked);
        }
        match what {
            Manage::Delete => return Ok(self.store.forget(id).await?),
            Manage::Visit => touched(&mut doc, now),
            Manage::Password(None) => doc.gate = None,
            Manage::Password(Some(password)) => {
                let mut salt = [0u8; 16];
                if !self.random.fill(&mut salt) {
                    return Err(Refused::NoRandomness);
                }
                doc.gate = Some(
                    keys::gate(&password, salt, self.policy.slowness)
                        .ok_or(Refused::NoRandomness)?,
                );
            }
            Manage::Idle(seconds) => {
                doc.idle = seconds.min(self.policy.idle).max(1);
                touched(&mut doc, now);
            }
            // Paused, the idle clock stops and the trash's starts (decision 51).
            Manage::Pause => {
                doc.paused = Some(now);
                doc.ends = now + self.policy.trash;
            }
            Manage::Restore => {
                doc.paused = None;
                touched(&mut doc, now);
            }
        }
        self.saved(&mut doc).await
    }

    /// Everything whose time ran out goes, links, envelopes, counters and reports alike; a Worker runs this on a schedule.
    pub async fn sweep(&self, now: i64) -> Result<Swept, Refused> {
        let mut swept = Swept::default();
        // Lapsing first, so evidence past its days goes even when forgetting stops, and its failure stops nothing.
        if let Err(fault) = self.store.lapse(now).await {
            swept.unlapsed = Some(fault);
        }
        // Twice as many are asked for, so documents that would not go lately never take every place.
        let ending = self
            .store
            .ending(now, self.policy.sweep.saturating_mul(2))
            .await?;
        let mut tried = 0;
        for id in ending {
            if tried == self.policy.sweep {
                break;
            }
            let stuck = format!("stuck:{id}");
            if self.store.held(&stuck, now).await?.is_some() {
                continue;
            }
            tried += 1;
            match self.store.forget(&id).await {
                Ok(()) => swept.gone += 1,
                Err(fault) => {
                    // Not waiting a day only means it is tried again sooner, so that failing stops nothing.
                    let _ = self.store.hold(&stuck, now + DAY).await;
                    swept.stuck.push((id, fault));
                }
            }
        }
        Ok(swept)
    }

    pub(crate) async fn admit(&self, caller: IpAddr, act: Act, now: i64) -> Result<(), Refused> {
        guard::admit(&self.store, &self.policy, &self.secret, caller, act, now).await
    }

    /// A proof is spent once: marked until its challenge expires, so a second use finds it.
    pub(crate) async fn worked(
        &self,
        ask: &Ask<'_>,
        proof: &Proof,
        needed: u8,
        now: i64,
    ) -> Result<(), Refused> {
        guard::checked(&self.secret, &ask.bound(), proof, needed, now)?;
        // Marked in one step, so the same proof sent twice at once is still spent once.
        let spent = format!("spent:{}", proof.challenge.seed);
        if !self
            .store
            .mark(&spent, proof.challenge.expires, now)
            .await?
        {
            return Err(Refused::WorkRefused);
        }
        Ok(())
    }

    /// A reader is counted once a day under today's name for it, never under who it is (decision 47).
    async fn first_read_today(&self, id: &str, caller: IpAddr, now: i64) -> Result<bool, Refused> {
        let day = now.div_euclid(DAY);
        let who = guard::today(&self.secret, caller, now);
        // A mark, not a count, so a reader coming back the same day writes nothing.
        let seen = format!("seen:{id}:{who}");
        Ok(self.store.mark(&seen, (day + 1) * DAY, now).await?)
    }

    pub(crate) async fn owned(&self, id: &str, admin: &str, now: i64) -> Result<Doc, Refused> {
        let doc = self.live(id, now).await?;
        if keys::hashed(admin) != doc.admin {
            return Err(Refused::Forbidden);
        }
        Ok(doc)
    }

    /// A document whose time ran out reads as gone even before a sweep takes it away.
    pub(crate) async fn live(&self, id: &str, now: i64) -> Result<Doc, Refused> {
        match self.store.doc(id).await? {
            None => Err(Refused::Missing),
            Some(doc) if doc.ends < now => {
                // Gone whether or not it can be let go of now; a sweep tries again and tells why.
                let _ = self.store.forget(id).await;
                Err(Refused::Gone)
            }
            Some(doc) => Ok(doc),
        }
    }

    /// Reads the document again and applies `change` until it saves, for what must not be lost to a race.
    pub(crate) async fn retried(
        &self,
        id: &str,
        now: i64,
        change: impl Fn(&mut Doc) -> bool,
    ) -> Result<(), Refused> {
        let mut lost = Refused::Behind { latest: None };
        for _ in 0..4 {
            let mut doc = self.live(id, now).await?;
            if !change(&mut doc) {
                return Ok(());
            }
            match self.saved(&mut doc).await {
                Ok(()) => return Ok(()),
                Err(behind @ Refused::Behind { .. }) => lost = behind,
                Err(other) => return Err(other),
            }
        }
        Err(lost)
    }

    pub(crate) async fn saved(&self, doc: &mut Doc) -> Result<(), Refused> {
        let was = doc.revision;
        doc.revision += 1;
        match self.store.save(doc, Some(was)).await? {
            Saved::Done => Ok(()),
            // Whoever saved first changed what this was decided on, so the caller learns what is there now.
            Saved::Raced => Err(Refused::Behind {
                latest: self
                    .store
                    .doc(&doc.id)
                    .await?
                    .and_then(|held| held.latest()),
            }),
        }
    }
}

fn open_to_read(doc: &Doc) -> Result<(), Refused> {
    if doc.blocked.is_some() {
        return Err(Refused::Blocked);
    }
    if doc.paused.is_some() {
        return Err(Refused::Paused);
    }
    Ok(())
}

/// Activity pushes the end back; a paused or blocked document keeps the end it was given.
fn touched(doc: &mut Doc, now: i64) {
    doc.active = now;
    if doc.paused.is_none() && doc.blocked.is_none() {
        doc.ends = now + doc.idle;
    }
}

/// The store lost what a version it names holds, so the reader is told of a fault, not of a missing document.
fn lost(id: &str, kept: &Kept) -> Refused {
    Refused::Store(Fault(format!(
        "the envelope of {id} version {} is not in the store",
        kept.version
    )))
}

#[cfg(test)]
#[path = "share_test.rs"]
mod tests;

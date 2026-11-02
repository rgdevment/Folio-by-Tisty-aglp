use tisty_share_proto::envelope::CITED_AT_MOST;

use crate::keys::{self, Randomness};
use crate::share::{Refused, Share};
use crate::store::{Doc, Store};

/// How long a held document reads, and the holders found gone without letting go of it.
pub(crate) struct Held {
    pub(crate) end: i64,
    pub(crate) lost: Vec<String>,
}

/// Shares one document may be held by, so a reader's check of who holds it stays a few reads.
pub const HOLDERS_AT_MOST: usize = 16;

/// The end a held document shows the sweep: past any day a server runs, and exact as a number in JavaScript.
pub const HELD: i64 = 253_402_300_799;

impl<S: Store, R: Randomness> Share<S, R> {
    /// The holder takes up a document it cites, proven its owner's by its management link; no ring of holders keeps itself alive (decision 64).
    pub(crate) async fn hold(
        &self,
        holder: &mut Doc,
        id: &str,
        admin: &str,
        lives: bool,
        now: i64,
    ) -> Result<(), Refused> {
        // Told apart from the holder being gone, so a Tisty shares this one anew rather than everything again.
        let held = match self.live(id, now).await {
            Err(Refused::Missing | Refused::Gone) => return Err(Refused::CitedGone),
            other => other?,
        };
        // Only its owner hands it over: an edit link would let whoever was given one take it up and let it go, and so end it.
        if keys::hashed(admin) != held.admin || id == holder.id || !holder.holders.is_empty() {
            return Err(Refused::Forbidden);
        }
        holdable(&held, &holder.id)?;
        if held.holders.contains(&holder.id) {
            return Ok(());
        }
        if holder.holds.len() >= CITED_AT_MOST {
            return Err(Refused::TooLong);
        }
        // The holder says it holds first: a holder naming one that does not hold back costs nothing, the other way round keeps it alive.
        if !holder.holds.iter().any(|one| one == id) {
            holder.holds.push(id.to_owned());
        }
        self.saved(holder).await?;
        let mut held = held;
        for _ in 0..4 {
            // Read again after a race, so what another save changed is weighed anew.
            holdable(&held, &holder.id)?;
            if held.holders.contains(&holder.id) {
                return Ok(());
            }
            if held.holders.is_empty() {
                held.own = lives.then_some(held.ends);
                held.ends = HELD;
            }
            held.holders.push(holder.id.clone());
            match self.saved(&mut held).await {
                Ok(()) => return Ok(()),
                Err(Refused::Behind { .. }) => held = self.live(id, now).await?,
                Err(other) => return Err(other),
            }
        }
        Err(Refused::Behind { latest: None })
    }

    /// The holder lets go of what it cited; one with no life of its own goes once nothing holds it.
    pub(crate) async fn release(&self, holder: &mut Doc, id: &str) -> Result<(), Refused> {
        // The document lets go first: a holder still naming it costs nothing, a document still naming the holder outlives it.
        self.let_go(id, &holder.id).await?;
        holder.holds.retain(|one| one != id);
        self.saved(holder).await
    }

    /// Its owner stops sharing a document something still holds: it keeps no life of its own, and lives on through its holders.
    pub(crate) async fn given_up(&self, doc: &mut Doc) -> Result<bool, Refused> {
        if doc.holders.is_empty() {
            return Ok(false);
        }
        // Paused and then stopped, nobody could restore it, so its holders' readers would find it paused for good.
        doc.own = None;
        doc.paused = None;
        self.saved(doc).await?;
        Ok(true)
    }

    /// The end its owner is told: its own while it has one, else the furthest its holders give it, never the sweep's far one.
    pub(crate) async fn told_end(&self, doc: &Doc, now: i64) -> i64 {
        match (doc.holders.is_empty(), doc.own) {
            (true, _) => doc.ends,
            (false, Some(own)) => own,
            (false, None) => self
                .held_up(doc, now)
                .await
                .map_or(doc.ends, |held| held.end),
        }
    }

    /// Everything a document held or was held by forgets it before it goes, so nothing it held outlives it unseen.
    pub(crate) async fn forgotten(&self, doc: &Doc) -> Result<(), Refused> {
        for held in &doc.holds {
            self.let_go(held, &doc.id).await?;
        }
        for holder in &doc.holders {
            self.changed(holder, |one| {
                let before = one.holds.len();
                one.holds.retain(|held| *held != doc.id);
                one.holds.len() != before
            })
            .await?;
        }
        Ok(self.store.forget(&doc.id).await?)
    }

    /// A held document reads while a holder does or its own life lasts, and the end a reader is told is the furthest of those (decision 64).
    pub(crate) async fn held_up(&self, doc: &Doc, now: i64) -> Result<Held, Refused> {
        if doc.holders.is_empty() {
            return Ok(Held {
                end: doc.ends,
                lost: Vec::new(),
            });
        }
        let mut paused = false;
        let mut lost = Vec::new();
        let mut ends = doc.own.filter(|end| *end >= now);
        for holder in &doc.holders {
            match self.store.doc(holder).await? {
                Some(one) if one.ends < now => lost.push(holder.clone()),
                Some(one) if one.paused.is_some() || one.blocked.is_some() => paused = true,
                Some(one) => ends = ends.max(Some(one.ends)),
                None => lost.push(holder.clone()),
            }
        }
        // A holder that went without letting go, its store failing midway, is let go of once the read is answered.
        match (ends, paused) {
            (Some(end), _) => Ok(Held { end, lost }),
            (None, true) => Err(Refused::Paused),
            (None, false) => {
                // Nothing holds it up any more, and its far end would keep it from every sweep, so it is let go of now.
                for holder in &lost {
                    self.let_go(&doc.id, holder).await?;
                }
                Err(Refused::Gone)
            }
        }
    }

    /// One holder lets go: the document keeps its own end again, or goes when it had none.
    pub(crate) async fn let_go(&self, id: &str, holder: &str) -> Result<(), Refused> {
        for _ in 0..4 {
            let Some(mut doc) = self.store.doc(id).await? else {
                return Ok(());
            };
            if !doc.holders.iter().any(|one| one == holder) {
                return Ok(());
            }
            doc.holders.retain(|one| one != holder);
            if doc.holders.is_empty() {
                match (doc.blocked, doc.own.take()) {
                    // Blocked, it is evidence, kept as long as moderation keeps any (decision 42).
                    (Some(blocked), _) => doc.ends = blocked + self.policy.evidence,
                    (None, Some(end)) => doc.ends = end,
                    (None, None) => return Ok(self.store.forget(id).await?),
                }
            }
            match self.saved(&mut doc).await {
                Ok(()) => return Ok(()),
                Err(Refused::Behind { .. }) => continue,
                Err(other) => return Err(other),
            }
        }
        Err(Refused::Behind { latest: None })
    }

    /// Applies `change` to what is stored now until it saves, or not at all when it is gone or nothing changes.
    async fn changed(&self, id: &str, change: impl Fn(&mut Doc) -> bool) -> Result<(), Refused> {
        for _ in 0..4 {
            let Some(mut doc) = self.store.doc(id).await? else {
                return Ok(());
            };
            if !change(&mut doc) {
                return Ok(());
            }
            match self.saved(&mut doc).await {
                Ok(()) => return Ok(()),
                Err(Refused::Behind { .. }) => continue,
                Err(other) => return Err(other),
            }
        }
        Err(Refused::Behind { latest: None })
    }
}

// What keeps a document from being held, read again whenever a race makes it look anew.
fn holdable(held: &Doc, holder: &str) -> Result<(), Refused> {
    if !held.holds.is_empty() {
        return Err(Refused::Forbidden);
    }
    if held.blocked.is_some() {
        return Err(Refused::Blocked);
    }
    if held.holders.len() >= HOLDERS_AT_MOST && !held.holders.iter().any(|one| one == holder) {
        return Err(Refused::TooLong);
    }
    Ok(())
}

/// The end of a document's own life: a held one keeps it apart, so its holders' life is what the sweep sees.
pub(crate) fn ending_at(doc: &mut Doc, end: i64) {
    match (doc.holders.is_empty(), doc.own.as_mut()) {
        (true, _) => doc.ends = end,
        (false, Some(own)) => *own = end,
        (false, None) => {}
    }
}

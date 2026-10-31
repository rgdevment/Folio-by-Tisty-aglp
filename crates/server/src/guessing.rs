use std::net::IpAddr;

use tisty_share_proto::work::Proof;

use crate::guard;
use crate::keys::{self, Randomness};
use crate::share::{Ask, Refused, Share};
use crate::store::{Doc, Store};

const DAY: i64 = 24 * 60 * 60;

/// Named by today's name for the network, so counters a day apart are never one reader's.
struct Place {
    tries: String,
    rights: String,
    wrongs: String,
    /// Only IPv6 has one: a /48 hands out 65,536 networks of its own, and an IPv4 block is too many homes.
    wide: Option<String>,
    known: String,
    until: i64,
}

impl<S: Store, R: Randomness> Share<S, R> {
    /// A wrong password counts against the network that said it, so a guesser never locks the readers out (decision 76).
    pub(crate) async fn let_in(
        &self,
        doc: &Doc,
        password: Option<&str>,
        proof: Option<&Proof>,
        caller: IpAddr,
        now: i64,
    ) -> Result<(), Refused> {
        let Some(gate) = doc.gate.as_ref() else {
            return Ok(());
        };
        let Some(password) = password else {
            return Err(Refused::PasswordAsked);
        };
        let place = self.place(&doc.id, &gate.salt, caller, now);
        let (guessed, day_ends) = guessed_today(&doc.id, now);
        let misses_today = self.store.counted(&guessed, now).await?;
        let (misses, misses_wide) = self.misses(misses_today);
        // Read before any work is spent, so a network already waiting never pays for a proof it cannot use.
        if self.store.counted(&place.wrongs, now).await? >= misses {
            return Err(Refused::PasswordLocked { until: place.until });
        }
        // A network that said this password today skips work and its block's count, which a guesser beside it cannot spend.
        let known = self.store.held(&place.known, now).await?.is_some();
        if !known {
            if let Some(wide) = &place.wide
                && self.store.counted(wide, now).await? >= misses_wide
            {
                return Err(Refused::PasswordLocked { until: place.until });
            }
            let needed = self
                .policy
                .work
                .for_password(misses_today, self.policy.guessed);
            if needed > 0 {
                let ask = Ask::Password { id: &doc.id };
                self.worked(&ask, proof.ok_or(Refused::WorkAsked)?, needed, now)
                    .await?;
            }
        }
        // Counted before weighing, known or not, so guesses sent together stop at twice the limit however many are in flight.
        let tried = self.store.count(&place.tries, 1, place.until, now).await?;
        if tried > 2 * misses
            && tried.saturating_sub(self.store.counted(&place.rights, now).await?) > 2 * misses
        {
            return Err(Refused::PasswordLocked { until: place.until });
        }
        if keys::opens(gate, password) {
            self.store.count(&place.rights, 1, place.until, now).await?;
            if !known {
                self.store.mark(&place.known, day_ends, now).await?;
            }
            return Ok(());
        }
        self.store.count(&place.wrongs, 1, place.until, now).await?;
        if let Some(wide) = &place.wide {
            self.store.count(wide, 1, place.until, now).await?;
        }
        self.store.count(&guessed, 1, day_ends, now).await?;
        Err(Refused::PasswordWrong)
    }

    /// Read and never counted, so asking what a password costs writes nothing.
    pub(crate) async fn password_work(&self, id: &str, now: i64) -> Result<u8, Refused> {
        let (guessed, _) = guessed_today(id, now);
        let misses = self.store.counted(&guessed, now).await?;
        Ok(self.policy.work.for_password(misses, self.policy.guessed))
    }

    // Past `guessed_most` a day, every network and block gets a fifth of its tries, so spreading out buys a guesser little.
    fn misses(&self, misses_today: u64) -> (u64, u64) {
        let policy = &self.policy;
        match misses_today >= policy.guessed_most {
            true => ((policy.misses / 5).max(1), (policy.misses_wide / 5).max(1)),
            false => (policy.misses, policy.misses_wide),
        }
    }

    fn place(&self, id: &str, salt: &[u8; 16], caller: IpAddr, now: i64) -> Place {
        let locked = self.policy.locked.max(1);
        let stretch = now.div_euclid(locked);
        let who = guard::today(&self.secret, caller, now);
        Place {
            tries: format!("tries:{id}:{who}:{stretch}"),
            rights: format!("rights:{id}:{who}:{stretch}"),
            wrongs: format!("wrongs:{id}:{who}:{stretch}"),
            wide: guard::today_wide(&self.secret, caller, now)
                .map(|block| format!("wide:{id}:{block}:{stretch}")),
            // Tied to this password's salt, so a password changed after a leak is not known anywhere yet.
            known: format!("known:{id}:{}:{who}", guard::hex(&salt[..4])),
            until: (stretch + 1) * locked,
        }
    }
}

fn guessed_today(id: &str, now: i64) -> (String, i64) {
    let day = now.div_euclid(DAY);
    (format!("guessed:{id}:{day}"), (day + 1) * DAY)
}

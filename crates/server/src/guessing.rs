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
    /// The IPv6 blocks it sits in with their allowance: a /48 holds 65,536 networks and a /32 as many /48s. IPv4 has
    /// none, since a block of those is too many homes.
    blocks: Vec<(String, u64)>,
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
        let (guessed, day_ends) = guessed_today(&doc.id, now);
        let misses_today = self.store.counted(&guessed, now).await?;
        let place = self.place(&doc.id, &gate.salt, caller, now, misses_today);
        let misses = self.cut(self.policy.misses, misses_today);
        // Read before any work is spent, so a network already waiting never pays for a proof it cannot use.
        if self.store.counted(&place.wrongs, now).await? >= misses {
            return Err(Refused::PasswordLocked { until: place.until });
        }
        // A network that said this password today skips work and its block's count, which a guesser beside it cannot spend.
        let known = self.store.held(&place.known, now).await?.is_some();
        if !known {
            for (block, most) in &place.blocks {
                if self.store.counted(block, now).await? >= *most {
                    return Err(Refused::PasswordLocked { until: place.until });
                }
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
        for (block, _) in &place.blocks {
            self.store.count(block, 1, place.until, now).await?;
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
    fn cut(&self, allowed: u64, misses_today: u64) -> u64 {
        match misses_today >= self.policy.guessed_most {
            true => (allowed / 5).max(1),
            false => allowed,
        }
    }

    fn place(
        &self,
        id: &str,
        salt: &[u8; 16],
        caller: IpAddr,
        now: i64,
        misses_today: u64,
    ) -> Place {
        let locked = self.policy.locked.max(1);
        let stretch = now.div_euclid(locked);
        let who = guard::today(&self.secret, caller, now);
        Place {
            tries: format!("tries:{id}:{who}:{stretch}"),
            rights: format!("rights:{id}:{who}:{stretch}"),
            wrongs: format!("wrongs:{id}:{who}:{stretch}"),
            blocks: [
                (48, self.policy.misses_wide),
                (32, self.policy.misses_wider),
            ]
            .into_iter()
            .filter_map(|(bits, allowed)| {
                let block = guard::today_block(&self.secret, caller, now, bits)?;
                Some((
                    format!("block{bits}:{id}:{block}:{stretch}"),
                    self.cut(allowed, misses_today),
                ))
            })
            .collect(),
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

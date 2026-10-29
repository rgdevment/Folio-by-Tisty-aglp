use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use tisty_share_proto::work::Proof;

use crate::guard::{self, Act};
use crate::keys::Randomness;
use crate::share::{Ask, Refused, Share};
use crate::store::Store;

/// Room for the why, short of a place to leave a document of one's own.
pub const DETAIL_AT_MOST: usize = 2_000;

/// What can be reported: only what is against the law (decisions 38 and 39), and the owner's own appeal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    ChildAbuse,
    Explicit,
    Intimate,
    Phishing,
    Malware,
    Fraud,
    Threat,
    Doxxing,
    /// The owner asking for a block to be looked at again, from the management link.
    Appeal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub category: Category,
    pub detail: String,
    /// The full link a reporter chose to give, sealed by the host for the operator before it gets here (decision 42).
    pub link: Option<Vec<u8>>,
    /// The reporter's lasting name, so three reports are three places and one place reports once (decision 41).
    pub by: String,
    pub at: i64,
    /// Kept as evidence this long, then it goes (decision 42).
    pub until: i64,
}

/// What a reader says about a document when reporting it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Complaint {
    pub category: Category,
    pub detail: String,
    pub link: Option<Vec<u8>>,
}

impl<S: Store, R: Randomness> Share<S, R> {
    /// Anyone may report, once per place, and the reports of three places block it (decisions 36 and 41).
    pub async fn report(
        &mut self,
        id: &str,
        complaint: Complaint,
        caller: IpAddr,
        proof: &Proof,
        now: i64,
    ) -> Result<(), Refused> {
        self.admit(caller, Act::Report, now).await?;
        if complaint.category == Category::Appeal {
            return Err(Refused::Forbidden);
        }
        if complaint.detail.chars().count() > DETAIL_AT_MOST {
            return Err(Refused::TooLong);
        }
        self.live(id, now).await?;
        let needed = self.policy.work.report;
        self.worked(&Ask::Report { id }, proof, needed, now).await?;
        let by = guard::lasting(&self.secret, caller, now, self.policy.evidence);
        let before = self.store.reports(id, now).await?;
        if before.iter().any(|one| one.by == by) {
            return Err(Refused::Reported);
        }
        self.store
            .file(&Report {
                id: id.to_owned(),
                category: complaint.category,
                detail: complaint.detail,
                link: complaint.link,
                by: by.clone(),
                at: now,
                until: now + self.policy.evidence,
            })
            .await?;
        let mut places: Vec<&str> = before
            .iter()
            .filter(|one| one.category != Category::Appeal)
            .map(|one| one.by.as_str())
            .collect();
        places.push(&by);
        places.sort_unstable();
        places.dedup();
        if places.len() >= self.policy.reports_to_block {
            let evidence = now + self.policy.evidence;
            // The report is already filed, so a race that loses the block must not lose it.
            self.retried(id, now, |held| {
                if held.blocked.is_some() {
                    return false;
                }
                held.blocked = Some(now);
                // What it was blocked for is kept as long as the reports are, even past its idle days.
                held.ends = held.ends.max(evidence);
                true
            })
            .await?;
        }
        Ok(())
    }

    /// The owner's word on a block, kept with the reports for the operator to look at again.
    pub async fn appeal(
        &mut self,
        id: &str,
        admin: &str,
        detail: &str,
        now: i64,
    ) -> Result<(), Refused> {
        if detail.chars().count() > DETAIL_AT_MOST {
            return Err(Refused::TooLong);
        }
        let doc = self.owned(id, admin, now).await?;
        if doc.blocked.is_none() {
            return Err(Refused::Missing);
        }
        // One appeal stands per block, so the owner says it once and the evidence stays readable.
        let filed = self.store.reports(id, now).await?;
        if filed.iter().any(|one| one.category == Category::Appeal) {
            return Err(Refused::Reported);
        }
        self.store
            .file(&Report {
                id: id.to_owned(),
                category: Category::Appeal,
                detail: detail.to_owned(),
                link: None,
                by: "owner".to_owned(),
                at: now,
                until: now + self.policy.evidence,
            })
            .await?;
        Ok(())
    }
}

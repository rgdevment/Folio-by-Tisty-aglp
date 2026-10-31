use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tisty_share_proto::identity::{REVOCATIONS_AT_ONCE, Revocation};

use crate::guard::Act;
use crate::keys::Randomness;
use crate::share::{Refused, Share};
use crate::store::{Sender, Store};

/// A key or a root as the store names it: its bytes, so two spellings of one are never two rows.
fn named(key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

impl<S: Store, R: Randomness> Share<S, R> {
    /// Anyone may carry a root's word taking keys back: the root's signature is the authority, not who brings it (decision 73).
    pub async fn revoke(
        &mut self,
        revocations: &[Revocation],
        caller: IpAddr,
        now: i64,
    ) -> Result<(), Refused> {
        if revocations.len() > REVOCATIONS_AT_ONCE {
            return Err(Refused::TooLong);
        }
        self.admit(caller, Act::Revoke, now).await?;
        let mut held = Vec::with_capacity(revocations.len());
        for one in revocations {
            held.push(one.holds().map_err(|_| Refused::Unsigned)?);
        }
        for ((person, share), one) in held.iter().zip(revocations) {
            self.store
                .revoke(&named(share.as_bytes()), &named(&person.to_bytes()), one)
                .await?;
        }
        Ok(())
    }

    /// What the root that vouched for this sender said taking it back; another root's word on the key is no concern of its readers.
    pub(crate) async fn revoked(&self, by: Option<&Sender>) -> Result<Vec<Revocation>, Refused> {
        let Some(by) = by else {
            return Ok(Vec::new());
        };
        let said = self
            .store
            .revocation(&named(&by.share), &named(&by.root))
            .await?;
        Ok(said.into_iter().filter(|one| one.holds().is_ok()).collect())
    }
}

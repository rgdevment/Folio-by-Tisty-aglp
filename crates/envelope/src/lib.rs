pub mod config;
pub mod envelope;
pub mod limits;
#[cfg(feature = "pictures")]
pub mod pictures;
pub mod work;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

#[cfg(feature = "mint")]
fn minted() -> Option<Zeroizing<[u8; 32]>> {
    let mut fresh = Zeroizing::new([0u8; 32]);
    rand_core::TryRngCore::try_fill_bytes(&mut rand_core::OsRng, fresh.as_mut()).ok()?;
    Some(fresh)
}

fn mac<const N: usize>(key: &[u8; N], parts: &[&[u8]]) -> Zeroizing<[u8; 32]> {
    const { assert!(N <= 64) };
    let mut block = hmac::digest::Key::<Hmac<Sha256>>::default();
    block[..N].copy_from_slice(key);
    let mut over = <Hmac<Sha256> as KeyInit>::new(&block);
    block.as_mut_slice().zeroize();
    parts.iter().for_each(|part| over.update(part));
    let mut said = over.finalize().into_bytes();
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&said);
    said.zeroize();
    out
}

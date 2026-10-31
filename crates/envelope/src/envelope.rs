use std::ops::Range;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{AeadInOut, KeyInit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::cloud::{HEAD, TAG, nonced};
use crate::identity::{Certificate, Revocation, ShareKey, Signed, Verdict, check};
use crate::limits::Limits;

/// A signature, its certificate and their names fit well inside this.
const SIGNATURE_AT_MOST: usize = 2 * 1024;
/// What any server could ask for stays far below; only reading the format is held here, never a quota.
const MANIFEST_AT_MOST: usize = 16 * 1024;
const ID_AT_MOST: usize = 64;

const MAGIC: &[u8; 4] = b"\xffTSE";
/// Whatever changes the shape of the manifest or the signature is a new version, so an older reader says newer, not damaged.
const VERSION: u8 = 1;
const SAID: u32 = 1;
const PART: &[u8] = b"tisty-share.part.v1\0";
const SEALED: &[u8] = b"tisty-share.sealed.v1\0";
const WRITTEN: &[u8] = b"tisty-share.written.v1\0";
const COMMIT: &[u8] = b"tisty-share.commit.v1\0";
/// What the outer signature answers for: these sealed bytes, uploaded as this id and version.
pub const SENT: &str = "tisty-share.envelope.v1";
/// What the inner signature answers for: these words and pictures, shared as this id, then, as this name.
pub const WROTE: &str = "tisty-share.text.v1";
/// A person's name or alias, as long as Tisty lets one be.
pub const NAME_AT_MOST: usize = 80;

/// The key in the link's `#`: the server never sees it, and nothing about it comes from a password.
pub struct LinkKey(Zeroizing<[u8; 32]>);

impl LinkKey {
    #[cfg(feature = "mint")]
    pub fn minted() -> Option<Self> {
        crate::minted().map(Self)
    }

    pub fn from_bytes(key: &[u8; 32]) -> Self {
        Self(Zeroizing::new(*key))
    }

    pub fn to_text(&self) -> Zeroizing<String> {
        Zeroizing::new(URL_SAFE_NO_PAD.encode(self.0.as_ref()))
    }

    pub fn from_text(said: &str) -> Option<Self> {
        let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(said).ok()?);
        Some(Self::from_bytes(
            &<[u8; 32]>::try_from(bytes.as_slice()).ok()?,
        ))
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&*self.0).into())
    }

    /// The seal alone does not tie bytes to one key; this does, so no envelope reads one way to a reader and another to a moderator.
    fn commitment(&self, head: &[u8; HEAD]) -> [u8; 32] {
        *crate::seed::mac(&self.0, &[COMMIT, head])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    /// The inner signature, sealed like the words it answers for.
    Signature,
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl Kind {
    pub fn is_picture(self) -> bool {
        !matches!(self, Kind::Text | Kind::Signature)
    }

    pub fn media(self) -> &'static str {
        match self {
            Kind::Text => "text/markdown",
            Kind::Signature => "application/json",
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Webp => "image/webp",
            Kind::Gif => "image/gif",
        }
    }

    /// What the bytes say they are, by their first bytes: a declared kind has to match them.
    pub fn of_picture(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Kind::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Kind::Jpeg)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Kind::Webp)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Kind::Gif)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub kind: Kind,
    /// Sealed, tag included, so the server checks it against the bytes it holds.
    pub size: u64,
}

impl Part {
    pub fn plain(&self) -> u64 {
        self.size.saturating_sub(TAG as u64)
    }
}

/// What the server reads without the key: enough to hold every limit and nothing of what is said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub v: u32,
    pub id: String,
    pub version: u64,
    /// The version this upload was written on, so a change made over someone else's is caught.
    pub from: Option<u64>,
    pub head: String,
    /// What ties these bytes to the one key that opens them.
    pub commit: String,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("this is not a Tisty Share envelope")]
    Foreign,
    #[error("this envelope was sealed by a newer Tisty")]
    Newer,
    #[error("this envelope is damaged or was changed on the way")]
    Damaged,
    #[error("the text is over what this server takes")]
    TextTooBig,
    #[error("a picture is over what this server takes")]
    PictureTooBig,
    #[error("there are more pictures than this server takes")]
    TooManyPictures,
    #[error("the pictures are over what this server takes together")]
    PicturesTooBig,
    #[error("a picture is not the kind it says")]
    NotAPicture,
    #[error("this server does not take this kind of picture")]
    KindRefused,
    #[error("this envelope does not open with this key, or something changed it")]
    Locked,
    #[error("the signature could not be made")]
    Unsigned,
    #[error("the name signed with is longer than a name can be")]
    NameTooLong,
    #[error("there was no randomness to seal with")]
    NoRandomness,
}

impl Manifest {
    /// Every rule a server can hold without the key, so the server and every Tisty refuse the same things.
    pub fn holds(&self, limits: &Limits) -> Result<(), Refused> {
        match self.v {
            SAID => {}
            newer if newer > SAID => return Err(Refused::Newer),
            _ => return Err(Refused::Damaged),
        }
        let named = !self.id.is_empty()
            && self.id.len() <= ID_AT_MOST
            && self
                .id
                .bytes()
                .all(|one| one.is_ascii_alphanumeric() || one == b'-' || one == b'_');
        let ordered = self.version >= 1 && self.from.is_none_or(|from| from < self.version);
        let keyed = self.head().is_some() && self.commitment().is_some();
        if !named || !ordered || !keyed {
            return Err(Refused::Damaged);
        }
        self.parts_hold(limits)
    }

    fn parts_hold(&self, limits: &Limits) -> Result<(), Refused> {
        let (text, rest) = self.parts.split_first().ok_or(Refused::Damaged)?;
        if text.kind != Kind::Text || text.size < TAG as u64 {
            return Err(Refused::Damaged);
        }
        if text.plain() > limits.text {
            return Err(Refused::TextTooBig);
        }
        let pictures = match rest.split_first() {
            Some((signature, pictures)) if signature.kind == Kind::Signature => {
                if signature.size < TAG as u64 || signature.plain() > SIGNATURE_AT_MOST as u64 {
                    return Err(Refused::Damaged);
                }
                pictures
            }
            _ => rest,
        };
        if pictures
            .iter()
            .any(|one| !one.kind.is_picture() || one.size < TAG as u64)
        {
            return Err(Refused::Damaged);
        }
        if pictures.len() as u64 > limits.pictures {
            return Err(Refused::TooManyPictures);
        }
        if pictures.iter().any(|one| !limits.takes(one.kind)) {
            return Err(Refused::KindRefused);
        }
        if pictures.iter().any(|one| one.plain() > limits.picture) {
            return Err(Refused::PictureTooBig);
        }
        // The sizes are the uploader's word, so adding them up can never be what overflows.
        let all = pictures
            .iter()
            .fold(0u64, |all, one| all.saturating_add(one.plain()));
        if all > limits.all_pictures {
            return Err(Refused::PicturesTooBig);
        }
        Ok(())
    }

    fn head(&self) -> Option<[u8; HEAD]> {
        decoded(&self.head)
    }

    fn commitment(&self) -> Option<[u8; 32]> {
        decoded(&self.commit)
    }

    pub fn signed(&self) -> bool {
        self.parts
            .get(1)
            .is_some_and(|one| one.kind == Kind::Signature)
    }
}

/// A document sealed for one version: the manifest in the clear, each part sealed on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    manifest: Manifest,
    /// The envelope as it travels, kept whole so that reading one never copies its parts out.
    bytes: Vec<u8>,
    /// The manifest as it was written, since the seal holds these bytes and not their meaning.
    written: Range<usize>,
    parts: Vec<Range<usize>>,
    /// Worked out once, since checking the sender and keeping the bytes both ask for it.
    digest: [u8; 32],
    sent: Option<Signed>,
}

/// What a person shares: the words and their pictures, already recompressed by Tisty.
pub struct Draft<'a> {
    pub id: &'a str,
    pub version: u64,
    pub from: Option<u64>,
    pub text: &'a str,
    pub pictures: &'a [(Kind, &'a [u8])],
}

/// The machine's key and the certificate its person gave it, when it signs and the name it signs with, if any.
pub struct Signer<'a> {
    pub key: &'a ShareKey,
    pub certificate: &'a Certificate,
    pub at: jiff::Timestamp,
    pub name: Option<&'a str>,
}

/// The inner signature with what it says beside the words, sealed with them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Wrote {
    id: String,
    at: jiff::Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    signed: Signed,
}

/// What the writer's signature says besides who: when they signed, and the name they chose to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub at: jiff::Timestamp,
    pub name: Option<String>,
}

pub struct Opened {
    pub manifest: Manifest,
    pub text: Zeroizing<String>,
    pub pictures: Vec<(Kind, Zeroizing<Vec<u8>>)>,
    /// Who wrote these words and pictures, when the envelope carries their signature; one signed for another id is refused.
    pub wrote: Option<Verdict>,
    pub written: Option<Written>,
    /// Who sent these bytes as this version, when the envelope carries that signature.
    pub sent: Option<Verdict>,
}

#[cfg(feature = "mint")]
pub fn seal(
    key: &LinkKey,
    draft: &Draft,
    by: Option<&Signer>,
    limits: &Limits,
) -> Result<Envelope, Refused> {
    check_draft(draft)?;
    let inner = by.map(|signer| wrote(signer, draft)).transpose()?;
    sealed_with(key, draft, inner.as_deref(), by, limits)
}

/// Seals the words with an inner signature already made, which only `seal` and the tests that forge one make.
#[cfg(feature = "mint")]
fn sealed_with(
    key: &LinkKey,
    draft: &Draft,
    inner: Option<&[u8]>,
    by: Option<&Signer>,
    limits: &Limits,
) -> Result<Envelope, Refused> {
    let mut plain: Vec<(Kind, &[u8])> = vec![(Kind::Text, draft.text.as_bytes())];
    if let Some(inner) = inner {
        plain.push((Kind::Signature, inner));
    }
    plain.extend(draft.pictures.iter().copied());

    let head: [u8; HEAD] = {
        let minted = crate::minted().ok_or(Refused::NoRandomness)?;
        minted[..HEAD]
            .try_into()
            .map_err(|_| Refused::NoRandomness)?
    };
    let manifest = Manifest {
        v: SAID,
        id: draft.id.to_owned(),
        version: draft.version,
        from: draft.from,
        head: URL_SAFE_NO_PAD.encode(head),
        commit: URL_SAFE_NO_PAD.encode(key.commitment(&head)),
        parts: plain
            .iter()
            .map(|(kind, bytes)| Part {
                kind: *kind,
                size: (bytes.len() + TAG) as u64,
            })
            .collect(),
    };
    manifest.holds(limits)?;
    let written = serde_json::to_vec(&manifest).map_err(|_| Refused::Damaged)?;
    // Only the count of pictures makes a manifest long, and a reader would refuse one past this.
    if written.len() > MANIFEST_AT_MOST {
        return Err(Refused::TooManyPictures);
    }
    let mut bytes = MAGIC.to_vec();
    bytes.push(VERSION);
    let written_at = framing(&mut bytes, &written);
    let aad = bound(&written);
    let cipher = key.cipher();
    let last = plain.len() - 1;
    let mut parts = Vec::with_capacity(plain.len());
    for (at, (_, said)) in plain.iter().enumerate() {
        let mut sealed = Zeroizing::new(said.to_vec());
        cipher
            .encrypt_in_place(
                &nonced(&head, at as u32, at == last).into(),
                &aad,
                &mut *sealed,
            )
            .map_err(|_| Refused::Locked)?;
        let start = bytes.len();
        bytes.extend_from_slice(&sealed);
        parts.push(start..bytes.len());
    }
    let mut envelope = Envelope {
        digest: digested(&bytes, &written_at, &parts),
        manifest,
        bytes,
        written: written_at,
        parts,
        sent: None,
    };
    let sent = by
        .map(|signer| sign(signer, SENT, &envelope.answered()))
        .transpose()?;
    // Written here, where a failure can still say so, rather than dropped later on the way out.
    let trailer = match &sent {
        Some(sent) => serde_json::to_vec(sent).map_err(|_| Refused::Unsigned)?,
        None => Vec::new(),
    };
    if trailer.len() > SIGNATURE_AT_MOST {
        return Err(Refused::Unsigned);
    }
    framing(&mut envelope.bytes, &trailer);
    envelope.sent = sent;
    Ok(envelope)
}

/// The pictures must be what they say, so a file passed off as a picture never leaves Tisty.
#[cfg(feature = "mint")]
fn check_draft(draft: &Draft) -> Result<(), Refused> {
    if draft
        .pictures
        .iter()
        .any(|(kind, bytes)| !kind.is_picture() || Kind::of_picture(bytes) != Some(*kind))
    {
        return Err(Refused::NotAPicture);
    }
    Ok(())
}

/// The inner signature over the words, the id they are shared as, when and as whom, ready to seal.
#[cfg(feature = "mint")]
fn wrote(signer: &Signer, draft: &Draft) -> Result<Vec<u8>, Refused> {
    if signer.name.is_some_and(|name| !named_well(name)) {
        return Err(Refused::NameTooLong);
    }
    let said = vouched_words(
        &content(draft.text, draft.pictures),
        draft.id,
        signer.at,
        signer.name,
    );
    let wrote = Wrote {
        id: draft.id.to_owned(),
        at: signer.at,
        name: signer.name.map(str::to_owned),
        signed: sign(signer, WROTE, &said)?,
    };
    serde_json::to_vec(&wrote).map_err(|_| Refused::Unsigned)
}

#[cfg(feature = "mint")]
fn sign(signer: &Signer, about: &str, said: &[u8]) -> Result<Signed, Refused> {
    signer
        .key
        .sign(signer.certificate, about, said)
        .ok_or(Refused::Unsigned)
}

pub fn open(key: &LinkKey, envelope: &Envelope, revoked: &[Revocation]) -> Result<Opened, Refused> {
    let manifest = &envelope.manifest;
    let head = manifest.head().ok_or(Refused::Damaged)?;
    if manifest.commitment() != Some(key.commitment(&head)) {
        return Err(Refused::Locked);
    }
    let aad = bound(envelope.written());
    let cipher = key.cipher();
    let last = envelope.parts.len() - 1;
    let mut plain = Vec::with_capacity(envelope.parts.len());
    for at in 0..envelope.parts.len() {
        let mut bytes = Zeroizing::new(envelope.part(at).to_vec());
        cipher
            .decrypt_in_place(
                &nonced(&head, at as u32, at == last).into(),
                &aad,
                &mut *bytes,
            )
            .map_err(|_| Refused::Locked)?;
        plain.push(bytes);
    }
    let text = Zeroizing::new(String::from_utf8(plain[0].to_vec()).map_err(|_| Refused::Damaged)?);
    let first_picture = if manifest.signed() { 2 } else { 1 };
    let pictures = manifest.parts[first_picture..]
        .iter()
        .zip(&plain[first_picture..])
        .map(|(part, bytes)| match Kind::of_picture(bytes) {
            Some(kind) if kind == part.kind => Ok((kind, Zeroizing::new(bytes.to_vec()))),
            _ => Err(Refused::NotAPicture),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (wrote, written) = if manifest.signed() {
        let inner: Wrote = serde_json::from_slice(&plain[1]).map_err(|_| Refused::Damaged)?;
        if inner.name.as_deref().is_some_and(|name| !named_well(name)) {
            return Err(Refused::Damaged);
        }
        let shown: Vec<(Kind, &[u8])> = pictures
            .iter()
            .map(|(kind, bytes)| (*kind, bytes.as_slice()))
            .collect();
        let said = vouched_words(
            &content(&text, &shown),
            &inner.id,
            inner.at,
            inner.name.as_deref(),
        );
        // Words signed for another link are someone carrying them elsewhere, never the writer sharing them here.
        let verdict = match inner.id == manifest.id {
            true => check(&inner.signed, WROTE, &said, revoked),
            false => Verdict::Refused,
        };
        let written = Written {
            at: inner.at,
            name: inner.name,
        };
        (Some(verdict), Some(written))
    } else {
        (None, None)
    };
    Ok(Opened {
        manifest: manifest.clone(),
        text,
        pictures,
        wrote,
        written,
        sent: envelope.sender(revoked),
    })
}

impl Envelope {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn written(&self) -> &[u8] {
        &self.bytes[self.written.clone()]
    }

    fn part(&self, at: usize) -> &[u8] {
        &self.bytes[self.parts[at].clone()]
    }

    /// The key that says it sent these bytes and the root that says it vouched for it, unchecked,
    /// so a server can look for what that root took back.
    pub fn sender_vouched(&self) -> Option<crate::identity::Vouched> {
        self.sent.as_ref()?.certificate.unchecked()
    }

    /// Who sent these sealed bytes, checked without the key: what the server can say about an upload.
    pub fn sender(&self, revoked: &[Revocation]) -> Option<Verdict> {
        self.sent
            .as_ref()
            .map(|sent| check(sent, SENT, &self.answered(), revoked))
    }

    /// The id and the version are signed with the sealed bytes, so a signature never travels to another upload.
    fn answered(&self) -> Vec<u8> {
        let mut said = Vec::with_capacity(8 + self.manifest.id.len() + 8 + 32);
        said.extend_from_slice(&(self.manifest.id.len() as u64).to_be_bytes());
        said.extend_from_slice(self.manifest.id.as_bytes());
        said.extend_from_slice(&self.manifest.version.to_be_bytes());
        said.extend_from_slice(&self.digest());
        said
    }

    /// Over the manifest as written and every sealed part, each with its length.
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    /// Reads and holds every limit without the key, so a server can refuse before it stores anything.
    pub fn read(bytes: Vec<u8>, limits: &Limits) -> Result<Self, Refused> {
        if !bytes.starts_with(MAGIC) {
            return Err(Refused::Foreign);
        }
        let mut at = MAGIC.len();
        match bytes.get(at).copied().ok_or(Refused::Damaged)? {
            VERSION => {}
            newer if newer > VERSION => return Err(Refused::Newer),
            _ => return Err(Refused::Damaged),
        }
        at += 1;
        let written = framed(&bytes, &mut at, MANIFEST_AT_MOST)?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes[written.clone()]).map_err(|_| Refused::Damaged)?;
        manifest.holds(limits)?;
        let mut parts = Vec::with_capacity(manifest.parts.len());
        for part in &manifest.parts {
            let end = usize::try_from(part.size)
                .ok()
                .and_then(|size| at.checked_add(size))
                .filter(|end| *end <= bytes.len())
                .ok_or(Refused::Damaged)?;
            parts.push(at..end);
            at = end;
        }
        let trailer = framed(&bytes, &mut at, SIGNATURE_AT_MOST)?;
        if at != bytes.len() {
            return Err(Refused::Damaged);
        }
        let sent = match &bytes[trailer] {
            [] => None,
            said => Some(canonical(said)?),
        };
        Ok(Self {
            digest: digested(&bytes, &written, &parts),
            manifest,
            bytes,
            written,
            parts,
            sent,
        })
    }
}

/// A length, then that many bytes, never more than `most`; `at` moves past them.
fn framed(bytes: &[u8], at: &mut usize, most: usize) -> Result<Range<usize>, Refused> {
    let len = bytes
        .get(*at..)
        .and_then(<[u8]>::first_chunk::<4>)
        .ok_or(Refused::Damaged)?;
    let len = u32::from_be_bytes(*len) as usize;
    let start = *at + 4;
    if len > most || bytes.len() - start < len {
        return Err(Refused::Damaged);
    }
    *at = start + len;
    Ok(start..start + len)
}

/// The signature is the one part of the bytes no seal covers, so only the spelling Tisty writes is taken: one envelope, one set of bytes.
fn canonical(said: &[u8]) -> Result<Signed, Refused> {
    let sent: Signed = serde_json::from_slice(said).map_err(|_| Refused::Damaged)?;
    match serde_json::to_vec(&sent) {
        Ok(again) if again == said => Ok(sent),
        _ => Err(Refused::Damaged),
    }
}

#[cfg(feature = "mint")]
fn framing(bytes: &mut Vec<u8>, said: &[u8]) -> Range<usize> {
    bytes.extend_from_slice(&(said.len() as u32).to_be_bytes());
    let start = bytes.len();
    bytes.extend_from_slice(said);
    start..bytes.len()
}

fn digested(bytes: &[u8], written: &Range<usize>, parts: &[Range<usize>]) -> [u8; 32] {
    let mut over = Sha256::new();
    over.update(SEALED);
    for range in std::iter::once(written).chain(parts) {
        over.update((range.len() as u64).to_be_bytes());
        over.update(&bytes[range.clone()]);
    }
    over.finalize().into()
}

/// Every part is bound to this very manifest, so none can be moved to another or have its size or kind changed.
fn bound(written: &[u8]) -> Vec<u8> {
    let mut aad = PART.to_vec();
    aad.extend_from_slice(&Sha256::digest(written));
    aad
}

/// A name is a line a person can read as written: not too long, no edge of spaces, nothing unseen that hides
/// a letter or turns the text around, and no more digits than letters, so it never passes for a fingerprint.
pub fn named_well(name: &str) -> bool {
    let letters = name.chars().filter(|one| one.is_alphabetic()).count();
    let digits = name.chars().filter(char::is_ascii_digit).count();
    name.trim() == name
        && name.chars().count() <= NAME_AT_MOST
        && letters > 0
        && digits <= letters
        && !name.chars().any(|one| one.is_control() || unseen(one))
}

fn unseen(one: char) -> bool {
    matches!(
        one,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{2800}'
            | '\u{3164}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// The words' digest, the id they are shared as, the second they were signed and the name, each framed so none runs into the next.
fn vouched_words(content: &[u8], id: &str, at: jiff::Timestamp, name: Option<&str>) -> Vec<u8> {
    let mut said = content.to_vec();
    said.extend_from_slice(&(id.len() as u64).to_be_bytes());
    said.extend_from_slice(id.as_bytes());
    said.extend_from_slice(&at.as_second().to_be_bytes());
    match name {
        Some(name) => {
            said.push(1);
            said.extend_from_slice(&(name.len() as u64).to_be_bytes());
            said.extend_from_slice(name.as_bytes());
        }
        None => said.push(0),
    }
    said
}

/// The words and every picture, each with its kind and length, as the inner signature reads them.
fn content(text: &str, pictures: &[(Kind, &[u8])]) -> Vec<u8> {
    let mut over = Sha256::new();
    over.update(WRITTEN);
    over.update((text.len() as u64).to_be_bytes());
    over.update(text.as_bytes());
    for (kind, bytes) in pictures {
        over.update(kind.media().as_bytes());
        over.update((bytes.len() as u64).to_be_bytes());
        over.update(bytes);
    }
    over.finalize().to_vec()
}

fn decoded<const N: usize>(said: &str) -> Option<[u8; N]> {
    <[u8; N]>::try_from(URL_SAFE_NO_PAD.decode(said).ok()?.as_slice()).ok()
}

#[cfg(all(test, feature = "mint"))]
#[path = "envelope_test.rs"]
mod tests;

use std::ops::Range;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{AeadInOut, KeyInit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::cloud::{HEAD, TAG, nonced};
use crate::config::{CONFIG_AT_MOST, Config};
use crate::identity::{Certificate, Revocation, ShareKey, Signed, Verdict, check};
use crate::limits::Limits;

/// A signature, its certificate and their names fit well inside this.
const SIGNATURE_AT_MOST: usize = 2 * 1024;
// One picture's hash as the inner signature lists it: 43 characters, quotes and a comma, with room to spare.
const HASHED_PICTURE: usize = 48;
/// What any server could ask for stays far below; only reading the format is held here, never a quota.
const MANIFEST_AT_MOST: usize = 16 * 1024;
const ID_AT_MOST: usize = 64;

const MAGIC: &[u8; 4] = b"\xffTSE";
/// Laid out with an index and the sender's signature before the parts, so each is checked as it arrives (decision 92).
const LAID: u8 = 2;
/// The only manifest Tisty seals or reads: nobody shared before it, so nothing older is kept to be read.
const FORMAT: u32 = 4;
/// Deflate's best, which the writer's machine pays once so every reader downloads less.
#[cfg(feature = "mint")]
const DEFLATED_AS: u8 = 9;
const PART: &[u8] = b"tisty-share.part.v1\0";
const INDEXED: &[u8] = b"tisty-share.indexed.v1\0";
const HASH: usize = 32;
const WRITTEN: &[u8] = b"tisty-share.written.v1\0";
const COMMIT: &[u8] = b"tisty-share.commit.v1\0";
/// What the outer signature answers for: these sealed bytes, uploaded as this id and version.
pub const SENT: &str = "tisty-share.envelope.v1";
/// What the inner signature answers for: these words and pictures, shared as this id, then, as this name.
pub const WROTE: &str = "tisty-share.text.v1";
/// A person's name or alias, as long as Tisty lets one be.
pub const NAME_AT_MOST: usize = 80;
/// Documents one envelope may lead to, so a reader never walks an endless list (decision 64).
pub const CITED_AT_MOST: usize = 64;
/// What their list may weigh sealed: an id, a key, a title and a name each, many times over.
const CITED_BYTES_AT_MOST: u64 = 64 * 1024;
const TITLE_AT_MOST: usize = 200;

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
    /// The documents the words lead to, each in its own envelope (decision 64).
    Cited,
    /// The page Tisty drew from the words, which the web shows as it is (decision 91).
    Html,
    /// How Tisty read the words: title, tags, language, paper and front matter.
    Config,
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl Kind {
    /// Words deflate well and a picture is already compressed, so only the words, the page and what they say of it are deflated.
    pub fn deflated(self) -> bool {
        matches!(self, Kind::Text | Kind::Cited | Kind::Html | Kind::Config)
    }

    pub fn is_picture(self) -> bool {
        !matches!(
            self,
            Kind::Text | Kind::Signature | Kind::Cited | Kind::Html | Kind::Config
        )
    }

    pub fn media(self) -> &'static str {
        match self {
            Kind::Text => "text/markdown",
            Kind::Signature | Kind::Cited | Kind::Config => "application/json",
            Kind::Html => "text/html",
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
    /// Opened and inflated, so every limit holds on what a reader ends up with, never on what travels.
    pub len: u64,
}

impl Part {
    pub fn plain(&self) -> u64 {
        self.len
    }

    // A part that is not deflated opens to its sealed bytes less the tag, exactly, and one that is never travels much past it.
    fn fits(&self) -> bool {
        let Some(sealed) = self.size.checked_sub(TAG as u64) else {
            return false;
        };
        match self.kind.deflated() {
            true => sealed <= deflated_at_most(self.len),
            false => sealed == self.len,
        }
    }
}

/// Deflate stores what does not shrink a few bytes over its length, so a part past this carries what it does not say.
fn deflated_at_most(len: u64) -> u64 {
    len.saturating_add(len / 16).saturating_add(64)
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
    #[error("the drawn page is over what this server takes")]
    HtmlTooBig,
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
            FORMAT => {}
            newer if newer > FORMAT => return Err(Refused::Newer),
            _ => return Err(Refused::Damaged),
        }
        let named = named_id(&self.id);
        let ordered = self.version >= 1 && self.from.is_none_or(|from| from < self.version);
        let keyed = self.head().is_some() && self.commitment().is_some();
        if !named || !ordered || !keyed {
            return Err(Refused::Damaged);
        }
        self.parts_hold(limits)
    }

    fn parts_hold(&self, limits: &Limits) -> Result<(), Refused> {
        if self.parts.iter().any(|one| !one.fits()) {
            return Err(Refused::Damaged);
        }
        // What a reader needs to paint comes first and the words last, so a reader by ranges asks for them only to copy or download (decision 92).
        let (config, rest) = self.parts.split_first().ok_or(Refused::Damaged)?;
        let (text, rest) = rest.split_last().ok_or(Refused::Damaged)?;
        if config.kind != Kind::Config || config.plain() > CONFIG_AT_MOST || text.kind != Kind::Text
        {
            return Err(Refused::Damaged);
        }
        // The writer's signature lists the hash of each picture and of the words.
        let hashed = 1 + self
            .parts
            .iter()
            .filter(|one| one.kind.is_picture())
            .count();
        if text.plain() > limits.text {
            return Err(Refused::TextTooBig);
        }
        let rest = match rest.split_first() {
            Some((signature, rest)) if signature.kind == Kind::Signature => {
                if signature.plain() > (SIGNATURE_AT_MOST + HASHED_PICTURE * hashed) as u64 {
                    return Err(Refused::Damaged);
                }
                rest
            }
            _ => rest,
        };
        let rest = match rest.split_first() {
            Some((cited, rest)) if cited.kind == Kind::Cited => {
                if cited.plain() > CITED_BYTES_AT_MOST {
                    return Err(Refused::Damaged);
                }
                rest
            }
            _ => rest,
        };
        // Every version carries the page Tisty drew, which is all the web shows (decision 91).
        let (html, pictures) = rest
            .split_first()
            .filter(|(html, _)| html.kind == Kind::Html)
            .ok_or(Refused::Damaged)?;
        if html.plain() > limits.html {
            return Err(Refused::HtmlTooBig);
        }
        if pictures.iter().any(|one| !one.kind.is_picture()) {
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

    /// Where the parts an envelope may leave out begin: past its config and the writer's signature.
    fn first_optional(&self) -> usize {
        if self.signed() { 2 } else { 1 }
    }

    fn kind_at(&self, at: usize, kind: Kind) -> Option<usize> {
        self.parts
            .get(at)
            .is_some_and(|one| one.kind == kind)
            .then_some(at)
    }

    fn cited_at(&self) -> Option<usize> {
        self.kind_at(self.first_optional(), Kind::Cited)
    }

    // Right after what the words cite, or after the config and the signature when they cite nothing.
    fn html_at(&self) -> usize {
        self.cited_at().map_or(self.first_optional(), |at| at + 1)
    }

    fn first_picture(&self) -> usize {
        self.html_at() + 1
    }

    fn text_at(&self) -> usize {
        self.parts.len() - 1
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
    /// The hash of every sealed part, in the clear, before the parts.
    index: Range<usize>,
    parts: Vec<Range<usize>>,
    /// Worked out once, since checking the sender and keeping the bytes both ask for it.
    digest: [u8; 32],
    sent: Option<Signed>,
}

/// What a person shares: the words, the documents they lead to and their pictures, already recompressed by Tisty.
pub struct Draft<'a> {
    pub id: &'a str,
    pub version: u64,
    pub from: Option<u64>,
    pub text: &'a str,
    pub cited: &'a [Cited],
    /// The page Tisty drew from the words, which is all the web shows (decision 91).
    pub html: &'a str,
    pub config: Config,
    pub pictures: &'a [(Kind, &'a [u8])],
}

/// A document the words lead to, shared in its own envelope and held by the share that cites it (decision 64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cited {
    /// The name the words call it by, in their `tisty:doc/` cards.
    pub doc: String,
    pub id: String,
    /// The key that opens its envelope, which travels only sealed inside this one.
    pub key: String,
    pub title: String,
    /// Its place among the pages of the document it belongs to, when it is one, from 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<(u32, u32)>,
    /// The language it is the same document in, when it is one of the anchor's languages rather than cited by a card (decision 69 bis).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

impl Cited {
    fn holds(&self) -> bool {
        let short = |said: &str, most: usize| !said.is_empty() && said.chars().count() <= most;
        // A language is reached through the reader's choice, never a card, so only it may go without a card's name.
        let named = match &self.lang {
            Some(lang) => crate::config::langed(lang) && self.doc.chars().count() <= TITLE_AT_MOST,
            None => short(&self.doc, TITLE_AT_MOST),
        };
        named
            && short(&self.title, TITLE_AT_MOST)
            && named_id(&self.id)
            && LinkKey::from_text(&self.key).is_some()
            && self.page.is_none_or(|(at, of)| at >= 1 && at <= of)
    }
}

fn named_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_AT_MOST
        && id
            .bytes()
            .all(|one| one.is_ascii_alphanumeric() || one == b'-' || one == b'_')
}

/// The config as it is sealed and signed: one way of writing it, so the writer and the reader sign the same bytes.
#[cfg(feature = "mint")]
fn configured(config: &Config) -> Result<Zeroizing<Vec<u8>>, Refused> {
    serde_json::to_vec(config)
        .map(Zeroizing::new)
        .map_err(|_| Refused::Damaged)
}

/// The list as it is sealed: none at all when nothing is cited, so such an envelope is what it always was.
#[cfg(feature = "mint")]
fn cited_bytes(cited: &[Cited]) -> Result<Option<Zeroizing<Vec<u8>>>, Refused> {
    if cited.is_empty() {
        return Ok(None);
    }
    if cited.len() > CITED_AT_MOST || !cited.iter().all(Cited::holds) {
        return Err(Refused::Damaged);
    }
    serde_json::to_vec(cited)
        .map(|said| Some(Zeroizing::new(said)))
        .map_err(|_| Refused::Damaged)
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
    /// The hash of every picture as written, so the words hold before the pictures arrive and each one when it does.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pictures: Vec<String>,
    /// The hash of the words as written, so the page holds before they arrive.
    text: String,
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
    pub cited: Vec<Cited>,
    /// The page Tisty drew: the writer's word, so whoever shows it still cleans it.
    pub html: Zeroizing<String>,
    /// How the writer's Tisty read the words, signed with them.
    pub config: Config,
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
    let cited = cited_bytes(draft.cited)?;
    let cited = cited.as_ref().map(|said| said.as_slice());
    let inner = by.map(|signer| wrote(signer, draft, cited)).transpose()?;
    sealed_with(key, draft, inner.as_deref(), cited, by, limits)
}

/// Seals the words with an inner signature already made, which only `seal` and the tests that forge one make.
#[cfg(feature = "mint")]
fn sealed_with(
    key: &LinkKey,
    draft: &Draft,
    inner: Option<&[u8]>,
    cited: Option<&[u8]>,
    by: Option<&Signer>,
    limits: &Limits,
) -> Result<Envelope, Refused> {
    let text = deflated(draft.text.as_bytes())?;
    let html = deflated(draft.html.as_bytes())?;
    let config = configured(&draft.config)?;
    let config = (config.len(), deflated(&config)?);
    let cited = cited
        .map(|said| deflated(said).map(|sealed| (said.len(), sealed)))
        .transpose()?;
    // Each part as it is sealed, with its length once opened.
    let mut plain: Vec<(Kind, usize, &[u8])> = vec![(Kind::Config, config.0, &config.1)];
    if let Some(inner) = inner {
        plain.push((Kind::Signature, inner.len(), inner));
    }
    if let Some((len, said)) = &cited {
        plain.push((Kind::Cited, *len, said));
    }
    plain.push((Kind::Html, draft.html.len(), &html));
    plain.extend(
        draft
            .pictures
            .iter()
            .map(|(kind, bytes)| (*kind, bytes.len(), *bytes)),
    );
    plain.push((Kind::Text, draft.text.len(), &text));

    let head: [u8; HEAD] = {
        let minted = crate::minted().ok_or(Refused::NoRandomness)?;
        minted[..HEAD]
            .try_into()
            .map_err(|_| Refused::NoRandomness)?
    };
    let manifest = Manifest {
        v: FORMAT,
        id: draft.id.to_owned(),
        version: draft.version,
        from: draft.from,
        head: URL_SAFE_NO_PAD.encode(head),
        commit: URL_SAFE_NO_PAD.encode(key.commitment(&head)),
        parts: plain
            .iter()
            .map(|(kind, len, sealed)| Part {
                kind: *kind,
                size: (sealed.len() + TAG) as u64,
                len: *len as u64,
            })
            .collect(),
    };
    manifest.holds(limits)?;
    let written = serde_json::to_vec(&manifest).map_err(|_| Refused::Damaged)?;
    // Only the count of pictures makes a manifest long, and a reader would refuse one past this.
    if written.len() > MANIFEST_AT_MOST {
        return Err(Refused::TooManyPictures);
    }
    let aad = bound(&written);
    let cipher = key.cipher();
    let last = plain.len() - 1;
    let sealed = plain.iter().enumerate().map(|(at, (_, _, said))| {
        let mut sealed = Zeroizing::new(Vec::with_capacity(said.len() + TAG));
        sealed.extend_from_slice(said);
        cipher
            .encrypt_in_place(
                &nonced(&head, at as u32, at == last).into(),
                &aad,
                &mut *sealed,
            )
            .map_err(|_| Refused::Locked)?;
        Ok(std::mem::take(&mut *sealed))
    });
    let mut bytes = MAGIC.to_vec();
    bytes.push(LAID);
    let written_at = framing(&mut bytes, &written);
    let sealed = sealed.collect::<Result<Vec<_>, Refused>>()?;
    let hashes: Vec<u8> = sealed.iter().flat_map(Sha256::digest).collect();
    let index = framing(&mut bytes, &hashes);
    let mut envelope = Envelope {
        digest: [0; HASH],
        manifest,
        bytes,
        written: written_at,
        index,
        parts: Vec::with_capacity(sealed.len()),
        sent: None,
    };
    // The parts come after the sender's signature, so it answers for them through the index before they arrive.
    envelope.digest = envelope.indexed_digest();
    signed_by(&mut envelope, by)?;
    sealed.iter().for_each(|part| envelope.append(part));
    Ok(envelope)
}

// Written here, where a failure can still say so, rather than dropped later on the way out.
#[cfg(feature = "mint")]
fn signed_by(envelope: &mut Envelope, by: Option<&Signer>) -> Result<(), Refused> {
    let sent = by
        .map(|signer| sign(signer, SENT, &envelope.answered()))
        .transpose()?;
    let trailer = match &sent {
        Some(sent) => serde_json::to_vec(sent).map_err(|_| Refused::Unsigned)?,
        None => Vec::new(),
    };
    if trailer.len() > SIGNATURE_AT_MOST {
        return Err(Refused::Unsigned);
    }
    framing(&mut envelope.bytes, &trailer);
    envelope.sent = sent;
    Ok(())
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
    if !draft.config.holds() {
        return Err(Refused::Damaged);
    }
    Ok(())
}

/// The inner signature over the words, the id they are shared as, when and as whom, ready to seal.
#[cfg(feature = "mint")]
fn wrote(signer: &Signer, draft: &Draft, cited: Option<&[u8]>) -> Result<Vec<u8>, Refused> {
    if signer.name.is_some_and(|name| !named_well(name)) {
        return Err(Refused::NameTooLong);
    }
    let pictures: Vec<String> = draft
        .pictures
        .iter()
        .map(|(_, bytes)| hashed(bytes))
        .collect();
    let text = hashed(draft.text.as_bytes());
    let config = configured(&draft.config)?;
    let covered = drawn_content(&text, cited, draft.html, &config, draft.pictures, &pictures)
        .ok_or(Refused::Unsigned)?;
    let said = vouched_words(&covered, draft.id, signer.at, signer.name);
    let wrote = Wrote {
        id: draft.id.to_owned(),
        at: signer.at,
        name: signer.name.map(str::to_owned),
        pictures,
        text,
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
        let part = &manifest.parts[at];
        plain.push(match part.kind.deflated() {
            true => inflated(&bytes, part.len)?,
            false => bytes,
        });
    }
    let text = Zeroizing::new(worded(&plain[manifest.text_at()])?);
    let cited_bytes = manifest.cited_at().map(|at| plain[at].as_slice());
    let cited: Vec<Cited> = match cited_bytes {
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| Refused::Damaged)?,
        None => Vec::new(),
    };
    // An empty list is never sealed, so one that reads empty or past what is allowed was made by hand.
    if cited_bytes.is_some()
        && (cited.is_empty() || cited.len() > CITED_AT_MOST || !cited.iter().all(Cited::holds))
    {
        return Err(Refused::Damaged);
    }
    let html = Zeroizing::new(worded(&plain[manifest.html_at()])?);
    let config_bytes = plain[0].as_slice();
    let config: Config = serde_json::from_slice(config_bytes).map_err(|_| Refused::Damaged)?;
    if !config.holds() {
        return Err(Refused::Damaged);
    }
    let shown_at = manifest.first_picture()..manifest.text_at();
    let pictures = manifest.parts[shown_at.clone()]
        .iter()
        .zip(&plain[shown_at])
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
        let said = drawn_content(
            &inner.text,
            cited_bytes,
            &html,
            config_bytes,
            &shown,
            &inner.pictures,
        )
        .map(|covered| vouched_words(&covered, &inner.id, inner.at, inner.name.as_deref()));
        // Each picture and the words must be the ones the writer hashed, which holds them apart from the page they signed.
        let pictured =
            pictures_hold(&shown, &inner.pictures) && hashed(text.as_bytes()) == inner.text;
        // The server tells only the sender's revocations, so words another key wrote, or signed for another link, never hold.
        let verdict = match (said, inner.id == manifest.id && pictured, &envelope.sent) {
            (None, _, _) | (_, false, _) => Verdict::Refused,
            (_, true, Some(sent)) if !same_key(&sent.certificate, &inner.signed.certificate) => {
                Verdict::Refused
            }
            (Some(said), true, _) => check(&inner.signed, WROTE, &said, revoked),
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
        cited,
        html,
        config,
        pictures,
        wrote,
        written,
        sent: envelope.sender(revoked),
    })
}

// One machine's key under one root, whatever certificate it carried that day.
fn same_key(one: &Certificate, other: &Certificate) -> bool {
    one.share == other.share && one.root == other.root
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

    /// Over the manifest and every sealed part, or over the manifest and the index that hashes every part.
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    #[cfg(feature = "mint")]
    fn append(&mut self, part: &[u8]) {
        let start = self.bytes.len();
        self.bytes.extend_from_slice(part);
        self.parts.push(start..self.bytes.len());
    }

    fn indexed_digest(&self) -> [u8; 32] {
        let mut over = Sha256::new();
        over.update(INDEXED);
        for range in [&self.written, &self.index] {
            over.update((range.len() as u64).to_be_bytes());
            over.update(&self.bytes[range.clone()]);
        }
        over.finalize().into()
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
            LAID => {}
            newer if newer > LAID => return Err(Refused::Newer),
            _ => return Err(Refused::Damaged),
        }
        at += 1;
        let written = framed(&bytes, &mut at, MANIFEST_AT_MOST)?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes[written.clone()]).map_err(|_| Refused::Damaged)?;
        manifest.holds(limits)?;
        Self::read_laid(bytes, at, written, manifest)
    }

    // The index and the sender's signature come before the parts, and every part must be the one the index hashes.
    fn read_laid(
        bytes: Vec<u8>,
        mut at: usize,
        written: Range<usize>,
        manifest: Manifest,
    ) -> Result<Self, Refused> {
        let index = framed(&bytes, &mut at, HASH * manifest.parts.len())?;
        if index.len() != HASH * manifest.parts.len() {
            return Err(Refused::Damaged);
        }
        let trailer = framed(&bytes, &mut at, SIGNATURE_AT_MOST)?;
        let sent = sent_in(&bytes[trailer])?;
        let parts = parts_from(&manifest, &bytes, &mut at)?;
        let unlike = parts
            .iter()
            .zip(bytes[index.clone()].chunks(HASH))
            .any(|(part, hash)| Sha256::digest(&bytes[part.clone()]).as_slice() != hash);
        if unlike || at != bytes.len() {
            return Err(Refused::Damaged);
        }
        let mut envelope = Self {
            digest: [0; HASH],
            manifest,
            bytes,
            written,
            index,
            parts,
            sent,
        };
        envelope.digest = envelope.indexed_digest();
        Ok(envelope)
    }
}

/// Every part the manifest lists, one after the other from `at`, never past the bytes; `at` moves past them.
fn parts_from(
    manifest: &Manifest,
    bytes: &[u8],
    at: &mut usize,
) -> Result<Vec<Range<usize>>, Refused> {
    manifest
        .parts
        .iter()
        .map(|part| {
            let start = *at;
            let end = usize::try_from(part.size)
                .ok()
                .and_then(|size| start.checked_add(size))
                .filter(|end| *end <= bytes.len())
                .ok_or(Refused::Damaged)?;
            *at = end;
            Ok(start..end)
        })
        .collect()
}

fn sent_in(trailer: &[u8]) -> Result<Option<Signed>, Refused> {
    match trailer {
        [] => Ok(None),
        said => canonical(said).map(Some),
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

/// What the inner signature reads: the hash of the words and of each picture stands in for them, so the page holds before they arrive.
fn drawn_content(
    text_hash: &str,
    cited: Option<&[u8]>,
    html: &str,
    config: &[u8],
    pictures: &[(Kind, &[u8])],
    hashes: &[String],
) -> Option<Vec<u8>> {
    if pictures.len() != hashes.len() {
        return None;
    }
    let mut over = Sha256::new();
    over.update(WRITTEN);
    over.update(b"drawn");
    let parts: [(&[u8], &[u8]); 4] = [
        (b"text", text_hash.as_bytes()),
        (b"cited", cited.unwrap_or_default()),
        (b"html", html.as_bytes()),
        (b"config", config),
    ];
    for (named, said) in parts {
        over.update(named);
        over.update((said.len() as u64).to_be_bytes());
        over.update(said);
    }
    over.update((hashes.len() as u64).to_be_bytes());
    for ((kind, _), hash) in pictures.iter().zip(hashes) {
        for said in [kind.media(), hash] {
            over.update((said.len() as u64).to_be_bytes());
            over.update(said.as_bytes());
        }
    }
    Some(over.finalize().to_vec())
}

// Deflated in one go into room for its worst case, so no copy of the words is left behind by a buffer that grew.
#[cfg(feature = "mint")]
fn deflated(said: &[u8]) -> Result<Zeroizing<Vec<u8>>, Refused> {
    use miniz_oxide::deflate::core::{
        CompressorOxide, TDEFLFlush, TDEFLStatus, compress, create_comp_flags_from_zip_params,
    };
    let room =
        usize::try_from(deflated_at_most(said.len() as u64)).map_err(|_| Refused::Damaged)?;
    let mut sealed = Zeroizing::new(vec![0; room]);
    let mut compressor =
        CompressorOxide::new(create_comp_flags_from_zip_params(DEFLATED_AS.into(), 0, 0));
    match compress(&mut compressor, said, &mut sealed, TDEFLFlush::Finish) {
        (TDEFLStatus::Done, read, wrote) if read == said.len() => {
            sealed.truncate(wrote);
            Ok(sealed)
        }
        _ => Err(Refused::Damaged),
    }
}

// Inflated straight into exactly the length the manifest says, from every byte sealed, so a part never unfolds into more or hides more.
fn inflated(deflated: &[u8], len: u64) -> Result<Zeroizing<Vec<u8>>, Refused> {
    use miniz_oxide::inflate::TINFLStatus;
    use miniz_oxide::inflate::core::inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    use miniz_oxide::inflate::core::{DecompressorOxide, decompress};
    let len = usize::try_from(len).map_err(|_| Refused::Damaged)?;
    let mut opened = Zeroizing::new(vec![0; len]);
    let mut decompressor = Box::<DecompressorOxide>::default();
    let flags = TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    match decompress(&mut decompressor, deflated, &mut opened, 0, flags) {
        (TINFLStatus::Done, read, wrote) if read == deflated.len() && wrote == len => Ok(opened),
        _ => Err(Refused::Damaged),
    }
}

// Checked before it is copied, so words that are not text never leave a copy behind.
fn worded(plain: &[u8]) -> Result<String, Refused> {
    std::str::from_utf8(plain)
        .map(str::to_owned)
        .map_err(|_| Refused::Damaged)
}

// Each picture hashes to what the writer listed, and there are as many as the list says.
fn pictures_hold(pictures: &[(Kind, &[u8])], hashes: &[String]) -> bool {
    pictures.len() == hashes.len()
        && pictures
            .iter()
            .zip(hashes)
            .all(|((_, bytes), hash)| hashed(bytes) == *hash)
}

fn hashed(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

fn decoded<const N: usize>(said: &str) -> Option<[u8; N]> {
    <[u8; N]>::try_from(URL_SAFE_NO_PAD.decode(said).ok()?.as_slice()).ok()
}

#[cfg(all(test, feature = "mint"))]
#[path = "envelope_test.rs"]
mod tests;

use serde::Serialize;
use tisty_share_proto::envelope::{Envelope, Kind, LinkKey, Refused, Written, open};
use tisty_share_proto::identity::{Revocation, Verdict};
use tisty_share_proto::limits::Limits;
use zeroize::Zeroizing;

/// A version as its reader meets it: the page drawn as Tisty draws it, its pictures, and what is known of it.
pub struct Shown {
    /// The text as written, for the reader who downloads it.
    pub text: Zeroizing<String>,
    pub html: String,
    pub about: About,
    pub pictures: Vec<(Kind, Zeroizing<Vec<u8>>)>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct About {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub version: u64,
    /// Who wrote these words and pictures, when the envelope carries their signature.
    pub wrote: Option<Signed>,
    /// Who sent these bytes as this version, when the envelope carries that signature.
    pub sent: Option<Signed>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "is", rename_all = "snake_case")]
pub enum Signed {
    Holds {
        fingerprint: String,
        since: i64,
        #[serde(flatten)]
        written: Said,
    },
    /// The key was taken back, so nothing it signed can be told from a thief's.
    Revoked {
        fingerprint: String,
        at: i64,
        #[serde(flatten)]
        written: Said,
    },
    Refused,
    Unreadable,
}

/// What the writer signed beside the words: the name they chose and when; an uploader's signature says neither.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Said {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed: Option<i64>,
}

impl From<Option<Written>> for Said {
    fn from(written: Option<Written>) -> Self {
        written.map_or_else(Self::default, |one| Self {
            name: one.name,
            signed: Some(one.at.as_second()),
        })
    }
}

/// Why a link could not be read, as one word the page translates.
#[derive(Debug, PartialEq, Eq)]
pub enum Unread {
    /// The link carries no key, or one that is not a key.
    Keyless,
    /// The server's limits did not read.
    Limitless,
    Envelope(Refused),
}

impl Unread {
    pub fn word(&self) -> &'static str {
        match self {
            Self::Keyless => "keyless",
            Self::Limitless => "limitless",
            Self::Envelope(Refused::Locked) => "locked",
            Self::Envelope(Refused::Newer) => "newer",
            // Over Tisty's own limits, which the server's may be wider than.
            Self::Envelope(
                Refused::TextTooBig
                | Refused::PictureTooBig
                | Refused::TooManyPictures
                | Refused::PicturesTooBig
                | Refused::KindRefused,
            ) => "over",
            Self::Envelope(_) => "damaged",
        }
    }
}

/// Opens what the server sent with the key from the link, under Tisty's limits or the wider of those and the server's,
/// told of the keys taken back that the server passed on beside it.
pub fn shown(
    envelope: Vec<u8>,
    key: &str,
    limits: Option<&str>,
    revoked: Option<&str>,
) -> Result<Shown, Unread> {
    let key = LinkKey::from_text(key).ok_or(Unread::Keyless)?;
    let limits = match limits {
        Some(said) => roomier(serde_json::from_str(said).map_err(|_| Unread::Limitless)?),
        None => Limits::default(),
    };
    let envelope = Envelope::read(envelope, &limits).map_err(Unread::Envelope)?;
    let opened = open(&key, &envelope, &taken_back(revoked)).map_err(Unread::Envelope)?;
    let html = tisty_markdown::html(&tisty_markdown::read(&opened.text));
    let about = About {
        title: tisty_markdown::front::title(&opened.text),
        tags: tisty_markdown::front::tags(&opened.text),
        version: opened.manifest.version,
        wrote: opened.wrote.map(|one| signed(one, opened.written.into())),
        sent: opened.sent.map(|one| signed(one, Said::default())),
    };
    Ok(Shown {
        text: opened.text,
        html,
        about,
        pictures: opened.pictures,
    })
}

/// Only what a root signed is believed: the server can leave a revocation out, never make one up.
fn taken_back(said: Option<&str>) -> Vec<Revocation> {
    let mut revoked: Vec<Revocation> = said
        .and_then(|said| serde_json::from_str(said).ok())
        .unwrap_or_default();
    revoked.retain(|one| one.holds().is_ok());
    revoked
}

/// A server's limits bound what it takes from now on, so lowering them must not lock out what it took before.
fn roomier(server: Limits) -> Limits {
    let own = Limits::default();
    let mut kinds = own.kinds;
    for kind in server.kinds {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    Limits {
        text: server.text.max(own.text),
        picture: server.picture.max(own.picture),
        pictures: server.pictures.max(own.pictures),
        all_pictures: server.all_pictures.max(own.all_pictures),
        kinds,
    }
}

fn signed(verdict: Verdict, written: Said) -> Signed {
    match verdict {
        Verdict::Holds { person, since } => Signed::Holds {
            fingerprint: person.fingerprint(),
            since: since.as_second(),
            written,
        },
        Verdict::Revoked { person, at } => Signed::Revoked {
            fingerprint: person.fingerprint(),
            at: at.as_second(),
            written,
        },
        Verdict::Refused => Signed::Refused,
        Verdict::Unreadable => Signed::Unreadable,
    }
}

#[cfg(test)]
#[path = "shown_test.rs"]
mod tests;

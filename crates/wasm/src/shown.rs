use serde::Serialize;
use tisty_share_proto::envelope::{Envelope, Kind, LinkKey, Refused, open};
use tisty_share_proto::identity::Verdict;
use tisty_share_proto::limits::Limits;
use zeroize::Zeroizing;

/// A version as its reader meets it: the page drawn as Tisty draws it, its pictures, and what is known of it.
pub struct Shown {
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
    },
    /// The key was taken back, so nothing it signed can be told from a thief's.
    Revoked {
        fingerprint: String,
        at: i64,
    },
    Refused,
    Unreadable,
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

/// Opens what the server sent with the key from the link, under Tisty's limits or the wider of those and the server's.
pub fn shown(envelope: Vec<u8>, key: &str, limits: Option<&str>) -> Result<Shown, Unread> {
    let key = LinkKey::from_text(key).ok_or(Unread::Keyless)?;
    let limits = match limits {
        Some(said) => roomier(serde_json::from_str(said).map_err(|_| Unread::Limitless)?),
        None => Limits::default(),
    };
    let envelope = Envelope::read(envelope, &limits).map_err(Unread::Envelope)?;
    // The web learns of no revocation; a revoked key shows as holding until Tisty is asked.
    let opened = open(&key, &envelope, &[]).map_err(Unread::Envelope)?;
    let html = tisty_markdown::html(&tisty_markdown::read(&opened.text));
    let about = About {
        title: tisty_markdown::front::title(&opened.text),
        tags: tisty_markdown::front::tags(&opened.text),
        version: opened.manifest.version,
        wrote: opened.wrote.map(signed),
        sent: opened.sent.map(signed),
    };
    Ok(Shown {
        html,
        about,
        pictures: opened.pictures,
    })
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

fn signed(verdict: Verdict) -> Signed {
    match verdict {
        Verdict::Holds { person, since } => Signed::Holds {
            fingerprint: person.fingerprint(),
            since: since.as_second(),
        },
        Verdict::Revoked { person, at } => Signed::Revoked {
            fingerprint: person.fingerprint(),
            at: at.as_second(),
        },
        Verdict::Refused => Signed::Refused,
        Verdict::Unreadable => Signed::Unreadable,
    }
}

#[cfg(test)]
#[path = "shown_test.rs"]
mod tests;

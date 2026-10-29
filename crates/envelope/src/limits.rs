use serde::{Deserialize, Deserializer, Serialize};

use crate::envelope::Kind;

/// What one server takes in a version. Each server sets its own and says it, and Tisty seals to what it says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
// A field a server leaves out takes Tisty's own, so limits written by an older or newer server still read.
#[serde(default)]
pub struct Limits {
    /// Bytes of text a version may carry.
    pub text: u64,
    /// Bytes each picture may weigh.
    pub picture: u64,
    /// How many pictures a version may carry; none turns pictures off.
    pub pictures: u64,
    /// Bytes all the pictures of a version may weigh together.
    pub all_pictures: u64,
    /// The kinds of picture taken.
    #[serde(deserialize_with = "known")]
    pub kinds: Vec<Kind>,
}

impl Default for Limits {
    /// Tisty's own: a long document and a few screenshots, never a book or a comic in parts.
    fn default() -> Self {
        Self {
            text: 512 * 1024,
            picture: 512 * 1024,
            pictures: 10,
            all_pictures: 2 * 1024 * 1024,
            kinds: vec![Kind::Png, Kind::Jpeg, Kind::Webp, Kind::Gif],
        }
    }
}

impl Limits {
    pub fn takes(&self, kind: Kind) -> bool {
        kind.is_picture() && self.kinds.contains(&kind)
    }
}

/// A kind only a later Tisty knows is passed over, so a server that takes more never stops an older one sharing.
fn known<'de, D: Deserializer<'de>>(said: D) -> Result<Vec<Kind>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Named {
        Known(Kind),
        Other(serde::de::IgnoredAny),
    }
    Ok(Vec::<Named>::deserialize(said)?
        .into_iter()
        .filter_map(|one| match one {
            Named::Known(kind) => Some(kind),
            Named::Other(_) => None,
        })
        .collect())
}

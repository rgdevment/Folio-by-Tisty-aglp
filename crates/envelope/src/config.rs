use serde::{Deserialize, Serialize};

/// What sealed config may weigh opened: the front matter Tisty reads stops at 4 KB, and the rest is said once more.
pub const CONFIG_AT_MOST: u64 = 16 * 1024;
const TITLE_AT_MOST: usize = 200;
const TAGS_AT_MOST: usize = 64;
const KEYS_AT_MOST: usize = 32;
const VALUE_AT_MOST: usize = 500;
const LANG_AT_MOST: usize = 35;
const PAPER_AT_MOST: usize = 16;

/// How the writer's Tisty read the document, so a reader shows it without reading its Markdown (decision 91).
/// A field a later Tisty adds is passed over by this one, so the config grows without a new version.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The title Tisty keeps for the document, as its list shows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// The language the document says it is in, as a tag: `es`, `pt-BR`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// The paper it asks for; one a reader does not know is shown on its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sheets: bool,
    /// Only while laid in sheets.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub landscape: bool,
    /// Its front matter as Tisty read it, for the reader's details.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    pub key: String,
    pub values: Vec<String>,
}

impl Config {
    /// What Tisty itself would write, so a config made by hand that says more is refused like any damage.
    pub fn holds(&self) -> bool {
        self.title.as_deref().is_none_or(titled)
            && self.tags.len() <= TAGS_AT_MOST
            && self.tags.iter().all(|one| titled(one))
            && self.lang.as_deref().is_none_or(langed)
            && self.paper.as_deref().is_none_or(papered)
            && (self.sheets || !self.landscape)
            && self.fields.len() <= KEYS_AT_MOST
            && self.fields.iter().all(Field::holds)
    }

    /// Only what holds, so an odd front matter loses a field on the way rather than stopping the share.
    pub fn trimmed(mut self) -> Self {
        self.title = self.title.filter(|one| titled(one));
        self.tags.retain(|one| titled(one));
        self.tags.truncate(TAGS_AT_MOST);
        self.lang = self.lang.filter(|one| langed(one));
        self.paper = self.paper.filter(|one| papered(one));
        self.landscape &= self.sheets;
        self.fields.retain(Field::holds);
        self.fields.truncate(KEYS_AT_MOST);
        self
    }
}

impl Field {
    fn holds(&self) -> bool {
        titled(&self.key)
            && self
                .values
                .iter()
                .all(|value| value.chars().count() <= VALUE_AT_MOST)
    }
}

fn titled(said: &str) -> bool {
    !said.is_empty() && said.chars().count() <= TITLE_AT_MOST
}

pub(crate) fn langed(said: &str) -> bool {
    (2..=LANG_AT_MOST).contains(&said.len())
        && said
            .bytes()
            .all(|one| one.is_ascii_alphanumeric() || one == b'-')
}

fn papered(said: &str) -> bool {
    (1..=PAPER_AT_MOST).contains(&said.len()) && said.bytes().all(|one| one.is_ascii_lowercase())
}

#[cfg(test)]
#[path = "config_test.rs"]
mod tests;

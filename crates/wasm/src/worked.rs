use tisty_share_proto::work::{Challenge, solve};

/// The proof a server's challenge asks for, as the JSON it takes in `Tisty-Work`; nothing for a challenge that does not read.
pub fn solved(challenge: &str) -> Option<String> {
    let challenge: Challenge = serde_json::from_str(challenge).ok()?;
    serde_json::to_string(&solve(&challenge)?).ok()
}

#[cfg(test)]
#[path = "worked_test.rs"]
mod tests;

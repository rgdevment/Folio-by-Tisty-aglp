use super::*;
use crate::keys::Slowness;
use crate::store::Gate;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;

fn alone() -> Doc {
    Doc {
        id: "abc".into(),
        edit: [1; 32],
        admin: [2; 32],
        gate: None,
        versions: Vec::new(),
        created: NOW,
        active: NOW,
        idle: DAY,
        ends: NOW + DAY,
        paused: None,
        blocked: None,
        reads: 0,
        written: None,
        revision: 0,
        holders: Vec::new(),
        holds: Vec::new(),
        own: None,
    }
}

const BY: Sender = Sender {
    share: [3; 32],
    root: [4; 32],
};

#[test]
fn a_document_alone_and_open_waits_in_the_cache_under_its_own_tag_and_its_sender_s() {
    let kept = cached(&alone(), Some(&BY), NOW + DAY, NOW).unwrap();
    assert_eq!(kept.seconds, CACHED_AT_MOST);
    assert_eq!(kept.tags, vec![doc_tag("abc"), sender_tag(&BY)]);
    assert!(kept.tags[1].starts_with("by:"));
}

#[test]
fn it_leaves_the_cache_by_half_the_time_the_document_has_left() {
    let kept = cached(&alone(), None, NOW + 600, NOW).unwrap();
    assert_eq!(kept.seconds, 300);
    assert_eq!(kept.tags, vec![doc_tag("abc")]);
    assert_eq!(cached(&alone(), None, NOW + 1, NOW), None);
}

#[test]
fn behind_a_password_or_holding_or_held_it_never_waits_in_the_cache() {
    let gated = Doc {
        gate: Some(Gate {
            salt: [0; 16],
            digest: [0; 32],
            slowness: Slowness::default(),
            missed: 0,
            locked_until: None,
        }),
        ..alone()
    };
    let held = Doc {
        holders: vec!["root".into()],
        ..alone()
    };
    let holding = Doc {
        holds: vec!["page".into()],
        ..alone()
    };
    for one in [gated, held, holding] {
        assert_eq!(cached(&one, Some(&BY), NOW + DAY, NOW), None);
    }
}

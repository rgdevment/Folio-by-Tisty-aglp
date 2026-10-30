use jiff::Timestamp;
use tisty_share_proto::envelope::{Draft, Kind, LinkKey, Refused, Signer, seal};
use tisty_share_proto::identity::{Root, ShareKey};
use tisty_share_proto::limits::Limits;

use super::{About, Shown, Signed, Unread, shown};

const TEXT: &str = "---\ntitle: Docker en WSL2\ntags: [guía, docker]\n---\n\n# Antes de empezar\n\nAbre una terminal.\n\n![La consola](tisty:picture/0)\n";

fn key(n: u8) -> LinkKey {
    LinkKey::from_bytes(&[n; 32])
}

fn png(len: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(len, 3);
    bytes
}

fn sealed(text: &str, pictures: &[(Kind, &[u8])], by: Option<&Signer>) -> Vec<u8> {
    let draft = Draft {
        id: "k7Qm2xPa",
        version: 4,
        from: Some(3),
        text,
        pictures,
    };
    seal(&key(1), &draft, by, &Limits::default())
        .unwrap()
        .into_bytes()
}

fn read(envelope: Vec<u8>) -> Result<Shown, Unread> {
    shown(envelope, &key(1).to_text(), None)
}

#[test]
fn draws_the_text_as_tisty_does() {
    let page = read(sealed(TEXT, &[], None)).unwrap();
    let body = tisty_markdown::read(TEXT);
    assert_eq!(page.html, tisty_markdown::html(&body));
    assert!(page.html.contains("Antes de empezar"));
}

#[test]
fn says_its_title_tags_and_version() {
    let page = read(sealed(TEXT, &[], None)).unwrap();
    assert_eq!(
        page.about,
        About {
            title: Some("Docker en WSL2".into()),
            tags: vec!["guía".into(), "docker".into()],
            version: 4,
            wrote: None,
            sent: None,
        }
    );
}

#[test]
fn hands_back_its_pictures_in_order() {
    let first = png(40);
    let second = png(60);
    let page = read(sealed(
        TEXT,
        &[(Kind::Png, &first), (Kind::Png, &second)],
        None,
    ))
    .unwrap();
    let held: Vec<(Kind, Vec<u8>)> = page
        .pictures
        .iter()
        .map(|(kind, bytes)| (*kind, bytes.to_vec()))
        .collect();
    assert_eq!(held, vec![(Kind::Png, first), (Kind::Png, second)]);
}

#[test]
fn names_who_signed_it() {
    let root = Root::from_bytes(&[7; 32]);
    let share = ShareKey::from_bytes(&[8; 32]);
    let certificate = root.certify(&share.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &share,
        certificate: &certificate,
    };
    let page = read(sealed(TEXT, &[], Some(&signer))).unwrap();
    let holds = Signed::Holds {
        fingerprint: root.person().fingerprint(),
        suffix: root.person().suffix(),
        since: 1_000,
    };
    assert_eq!(page.about.wrote, Some(holds));
}

#[test]
fn another_key_finds_it_locked() {
    let refused = shown(sealed(TEXT, &[], None), &key(2).to_text(), None);
    assert_eq!(refused.err().map(|unread| unread.word()), Some("locked"));
}

#[test]
fn a_link_without_a_key_is_keyless() {
    for said in ["", "not a key", "AAAA"] {
        let refused = shown(sealed(TEXT, &[], None), said, None);
        assert_eq!(refused.err(), Some(Unread::Keyless), "{said:?}");
    }
}

#[test]
fn limits_that_do_not_read_are_limitless() {
    let refused = shown(sealed(TEXT, &[], None), &key(1).to_text(), Some("{"));
    assert_eq!(refused.err(), Some(Unread::Limitless));
}

#[test]
fn bytes_that_are_no_envelope_are_damaged() {
    let refused = read(b"<html>not an envelope</html>".to_vec());
    assert_eq!(refused.err().map(|unread| unread.word()), Some("damaged"));
}

#[test]
fn a_server_that_now_takes_less_still_opens_what_it_took() {
    let shut = serde_json::json!({ "text": 8, "pictures": 0, "kinds": [] }).to_string();
    let envelope = sealed(TEXT, &[(Kind::Png, &png(40))], None);
    let page = shown(envelope, &key(1).to_text(), Some(&shut)).unwrap();
    assert_eq!(page.pictures.len(), 1);
}

#[test]
fn a_server_that_takes_more_opens_what_only_it_took() {
    let roomy = Limits {
        text: 2 * Limits::default().text,
        ..Limits::default()
    };
    let long = "a".repeat(usize::try_from(Limits::default().text).unwrap() + 1);
    let draft = Draft {
        id: "k7Qm2xPa",
        version: 1,
        from: None,
        text: &long,
        pictures: &[],
    };
    let envelope = seal(&key(1), &draft, None, &roomy).unwrap().into_bytes();
    let said = serde_json::to_string(&roomy).unwrap();
    assert!(shown(envelope.clone(), &key(1).to_text(), Some(&said)).is_ok());
    let refused = shown(envelope, &key(1).to_text(), None).err();
    assert_eq!(refused.as_ref().map(Unread::word), Some("over"));
    assert_eq!(refused, Some(Unread::Envelope(Refused::TextTooBig)));
}

#[test]
fn a_picture_keeps_its_place_for_the_page_to_fill() {
    let page = read(sealed(TEXT, &[(Kind::Png, &png(40))], None)).unwrap();
    assert!(
        page.html
            .contains(r#"<img src="tisty:picture/0" alt="La consola""#)
    );
}

#[test]
fn keeps_the_text_as_written_for_the_reader_to_download() {
    let page = read(sealed(TEXT, &[], None)).unwrap();
    assert_eq!(page.text.as_str(), TEXT);
}

// The app draws a document with this same call (app/src-tauri/src/answers/paging.rs), so the guide to every
// part of the Tisty language drawn alike here is the web drawn as the app draws it.
#[test]
fn every_part_of_the_tisty_language_draws_as_the_app_draws_it() {
    for spanish in [true, false] {
        let guide = tisty_markdown::reference(spanish);
        let page = read(sealed(guide, &[], None)).unwrap();
        assert_eq!(
            page.html,
            tisty_markdown::html(&tisty_markdown::read(guide))
        );
        assert_eq!(page.text.as_str(), guide);
    }
}

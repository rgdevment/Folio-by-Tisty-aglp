use jiff::Timestamp;
use tisty_share_proto::config::Config;
use tisty_share_proto::envelope::{Draft, Envelope, Kind, LinkKey, Refused, Signer, seal};
use tisty_share_proto::identity::{Root, ShareKey};
use tisty_share_proto::limits::Limits;

use super::{About, Begun, Said, Shown, Signed, Unread, begun, shown};

const TEXT: &str = "---\ntitle: Docker en WSL2\ntags: [guía, docker]\n---\n\n# Antes de empezar\n\nAbre una terminal.\n\n![La consola](tisty:picture/0)\n";

fn key(n: u8) -> LinkKey {
    LinkKey::from_bytes(&[n; 32])
}

fn png(len: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(len, 3);
    bytes
}

// Sealed as Tisty seals a version now: the words with the page it drew from them and how it read them.
fn sealed(text: &str, pictures: &[(Kind, &[u8])], by: Option<&Signer>) -> Vec<u8> {
    let drawn = drawn(text);
    let draft = Draft {
        id: "k7Qm2xPa",
        version: 4,
        from: Some(3),
        text,
        cited: &[],
        html: &drawn,
        config: Config {
            title: tisty_markdown::front::title(text),
            tags: tisty_markdown::front::tags(text),
            paper: Some("letter".into()),
            ..Config::default()
        },
        pictures,
    };
    seal(&key(1), &draft, by, &Limits::default())
        .unwrap()
        .into_bytes()
}

fn read(envelope: Vec<u8>) -> Result<Shown, Unread> {
    shown(envelope, &key(1).to_text(), None, None)
}

fn drawn(text: &str) -> String {
    tisty_markdown::html(&tisty_markdown::read(text))
}

#[test]
fn shows_the_page_tisty_drew_without_drawing_it() {
    let page = read(sealed(TEXT, &[], None)).unwrap();
    assert_eq!(page.html, drawn(TEXT));
    assert!(page.html.contains("Antes de empezar"));
}

#[test]
fn says_how_tisty_read_it_and_its_version() {
    let page = read(sealed(TEXT, &[], None)).unwrap();
    assert_eq!(
        page.about,
        About {
            title: Some("Docker en WSL2".into()),
            tags: vec!["guía".into(), "docker".into()],
            lang: None,
            paper: Some("letter".into()),
            sheets: false,
            landscape: false,
            fields: Vec::new(),
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
fn names_who_signed_it_with_the_name_and_moment_they_signed() {
    let root = Root::from_bytes(&[7; 32]);
    let share = ShareKey::from_bytes(&[8; 32]);
    let certificate = root.certify(&share.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &share,
        certificate: &certificate,
        at: Timestamp::from_second(2_000).unwrap(),
        name: Some("Ana Pérez"),
    };
    let page = read(sealed(TEXT, &[], Some(&signer))).unwrap();
    let holds = Signed::Holds {
        fingerprint: root.person().fingerprint(),
        since: 1_000,
        written: Said {
            name: Some("Ana Pérez".into()),
            signed: Some(2_000),
        },
    };
    assert_eq!(page.about.wrote, Some(holds));
    let sent = serde_json::to_value(&page.about.sent).unwrap();
    assert!(sent.get("name").is_none() && sent.get("signed").is_none());
    let wrote = serde_json::to_value(&page.about.wrote).unwrap();
    assert_eq!(wrote["name"], "Ana Pérez");
    assert_eq!(wrote["signed"], 2_000);
}

#[test]
fn another_key_finds_it_locked() {
    let refused = shown(sealed(TEXT, &[], None), &key(2).to_text(), None, None);
    assert_eq!(refused.err().map(|unread| unread.word()), Some("locked"));
}

#[test]
fn a_link_without_a_key_is_keyless() {
    for said in ["", "not a key", "AAAA"] {
        let refused = shown(sealed(TEXT, &[], None), said, None, None);
        assert_eq!(refused.err(), Some(Unread::Keyless), "{said:?}");
    }
}

#[test]
fn limits_that_do_not_read_are_limitless() {
    let refused = shown(sealed(TEXT, &[], None), &key(1).to_text(), Some("{"), None);
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
    let page = shown(envelope, &key(1).to_text(), Some(&shut), None).unwrap();
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
        cited: &[],
        html: "<p>a</p>",
        config: Default::default(),
        pictures: &[],
    };
    let envelope = seal(&key(1), &draft, None, &roomy).unwrap().into_bytes();
    let said = serde_json::to_string(&roomy).unwrap();
    assert!(shown(envelope.clone(), &key(1).to_text(), Some(&said), None).is_ok());
    let refused = shown(envelope, &key(1).to_text(), None, None).err();
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

// The app draws every version with this same call (app/src-tauri/src/sharing.rs), so the guide to every part of
// the Tisty language comes through the envelope as the app drew it.
#[test]
fn every_part_of_the_tisty_language_comes_through_as_the_app_drew_it() {
    for spanish in [true, false] {
        let guide = tisty_markdown::reference(spanish);
        let page = read(sealed(guide, &[], None)).unwrap();
        assert_eq!(page.html, drawn(guide));
        assert_eq!(page.text.as_str(), guide);
    }
}

#[test]
fn says_a_key_taken_back_and_believes_only_what_its_root_signed() {
    let root = Root::from_bytes(&[7; 32]);
    let share = ShareKey::from_bytes(&[8; 32]);
    let certificate = root.certify(&share.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &share,
        certificate: &certificate,
        at: Timestamp::from_second(2_000).unwrap(),
        name: None,
    };
    let envelope = sealed(TEXT, &[], Some(&signer));
    let taken = root.revoke(&share.public(), Timestamp::from_second(2_000).unwrap());
    let mut forged = taken.clone();
    forged.at = Timestamp::from_second(3_000).unwrap();
    let told = |revoked: &[&tisty_share_proto::identity::Revocation]| {
        let said = serde_json::to_string(revoked).unwrap();
        shown(envelope.clone(), &key(1).to_text(), None, Some(&said))
            .unwrap()
            .about
            .wrote
    };

    assert!(matches!(
        told(&[&taken]),
        Some(Signed::Revoked { at: 2_000, .. })
    ));
    assert!(matches!(told(&[&forged]), Some(Signed::Holds { .. })));
    let garbled = shown(envelope.clone(), &key(1).to_text(), None, Some("{"));
    assert!(matches!(
        garbled.unwrap().about.wrote,
        Some(Signed::Holds { .. })
    ));
}

#[test]
fn hands_the_reader_what_the_words_cite_with_the_keys_that_open_them() {
    let cited = [tisty_share_proto::envelope::Cited {
        doc: "guia-2".into(),
        id: "pag2Xa".into(),
        key: key(2).to_text().to_string(),
        title: "Instalar en Windows".into(),
        page: Some((2, 3)),
        lang: None,
    }];
    let text = "![Instalar en Windows](tisty:doc/guia-2)";
    let page = drawn(text);
    let draft = Draft {
        id: "k7Qm2xPa",
        version: 1,
        from: None,
        text,
        cited: &cited,
        html: &page,
        config: Default::default(),
        pictures: &[],
    };
    let sealed = seal(&key(1), &draft, None, &Limits::default())
        .unwrap()
        .into_bytes();
    let page = read(sealed).unwrap();
    assert_eq!(page.cited, cited);
    // The card stays the sheet's to draw: the words still call it by its name in the store.
    assert!(page.html.contains("data-doc=\"guia-2\""));
}

fn split(envelope: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let read = Envelope::read(envelope.to_vec(), &Limits::default()).unwrap();
    let end = read.sheet_end().unwrap() as usize;
    (envelope[..end].to_vec(), envelope[end..].to_vec())
}

fn sheet(bytes: Vec<u8>) -> Result<Begun, Unread> {
    begun(bytes, &key(1).to_text(), None, None)
}

fn held(pictures: &[(Kind, zeroize::Zeroizing<Vec<u8>>)]) -> Vec<(Kind, Vec<u8>)> {
    pictures
        .iter()
        .map(|(kind, bytes)| (*kind, bytes.to_vec()))
        .collect()
}

#[test]
fn a_sheet_draws_at_once_and_its_rest_brings_the_pictures_and_the_text() {
    let root = Root::from_bytes(&[7; 32]);
    let share = ShareKey::from_bytes(&[8; 32]);
    let certificate = root.certify(&share.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &share,
        certificate: &certificate,
        at: Timestamp::from_second(2_000).unwrap(),
        name: Some("Ana Pérez"),
    };
    let picture = png(40);
    let envelope = sealed(TEXT, &[(Kind::Png, &picture)], Some(&signer));
    let whole = read(envelope.clone()).unwrap();
    let (ahead, after) = split(&envelope);

    let mut begun = sheet(ahead).unwrap();
    assert_eq!(begun.html, whole.html);
    assert_eq!(begun.about, whole.about);
    assert_eq!(begun.cited, whole.cited);
    assert_eq!(begun.kinds, vec![Kind::Png]);

    let arrived = begun.rest(after).unwrap();
    assert_eq!(arrived.text.as_str(), whole.text.as_str());
    assert_eq!(held(&arrived.pictures), held(&whole.pictures));
}

#[test]
fn a_rest_that_is_not_the_one_its_sheet_indexes_is_damaged_and_the_right_one_still_opens() {
    let picture = png(40);
    let envelope = sealed(TEXT, &[(Kind::Png, &picture)], None);
    let (ahead, after) = split(&envelope);
    let mut begun = sheet(ahead).unwrap();

    let mut changed = after.clone();
    changed[0] ^= 1;
    let refused = begun.rest(changed).err().map(|unread| unread.word());
    assert_eq!(refused, Some("damaged"));
    assert!(begun.rest(after).is_ok());
}

#[test]
fn a_sheet_cut_anywhere_but_its_page_s_end_or_under_another_key_does_not_open() {
    let picture = png(40);
    let envelope = sealed(TEXT, &[(Kind::Png, &picture)], None);
    let (ahead, _) = split(&envelope);
    let short = sheet(ahead[..ahead.len() - 1].to_vec());
    assert_eq!(short.err(), Some(Unread::Envelope(Refused::Damaged)));
    let whole = sheet(envelope);
    assert_eq!(whole.err(), Some(Unread::Envelope(Refused::Damaged)));
    let locked = begun(ahead, &key(2).to_text(), None, None);
    assert_eq!(locked.err().map(|unread| unread.word()), Some("locked"));
}

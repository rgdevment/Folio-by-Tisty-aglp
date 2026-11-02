use jiff::Timestamp;

use super::*;
use crate::identity::Root;

// Decision 5, what every server takes unless it says otherwise.
const TEXT_AT_MOST: usize = 512 * 1024;
const PICTURE_AT_MOST: usize = 512 * 1024;
const PICTURES_AT_MOST: usize = 10;

fn sealed(key: &LinkKey, draft: &Draft, by: Option<&Signer>) -> Result<Envelope, Refused> {
    seal(key, draft, by, &Limits::default())
}

fn read(bytes: &[u8]) -> Result<Envelope, Refused> {
    Envelope::read(bytes.to_vec(), &Limits::default())
}

fn key(n: u8) -> LinkKey {
    LinkKey::from_bytes(&[n; 32])
}

fn png(fill: u8, len: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(len, fill);
    bytes
}

fn jpeg(len: usize) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0];
    bytes.resize(len, 7);
    bytes
}

fn draft<'a>(text: &'a str, pictures: &'a [(Kind, &'a [u8])]) -> Draft<'a> {
    Draft {
        id: "k7Qm2xPa",
        version: 3,
        from: Some(2),
        text,
        cited: &[],
        html: None,
        pictures,
    }
}

struct Machine {
    root: Root,
    key: ShareKey,
    certificate: Certificate,
}

fn machine(n: u8) -> Machine {
    let root = Root::from_bytes(&[n; 32]);
    let key = ShareKey::from_bytes(&[n + 1; 32]);
    let certificate = root.certify(&key.public(), Timestamp::from_second(1_000).unwrap());
    Machine {
        root,
        key,
        certificate,
    }
}

impl Machine {
    fn signer(&self) -> Signer<'_> {
        Signer {
            key: &self.key,
            certificate: &self.certificate,
            at: jiff::Timestamp::from_second(1_000).unwrap(),
            name: None,
        }
    }
}

fn holds_for(verdict: Option<Verdict>, by: &Machine) -> bool {
    matches!(verdict, Some(Verdict::Holds { person, .. }) if person == by.root.person())
}

#[test]
fn a_document_with_pictures_crosses_from_one_tisty_to_another_signed() {
    let (one, two) = (png(1, 300), jpeg(200));
    let pictures = [(Kind::Png, one.as_slice()), (Kind::Jpeg, two.as_slice())];
    let mario = machine(1);
    let sealed = sealed(
        &key(9),
        &draft("# Plan\n\nHola.", &pictures),
        Some(&mario.signer()),
    )
    .unwrap();

    let arrived = read(&sealed.to_bytes()).unwrap();
    let opened = open(&key(9), &arrived, &[]).unwrap();

    assert_eq!(opened.text.as_str(), "# Plan\n\nHola.");
    let pictures: Vec<(Kind, &[u8])> = opened
        .pictures
        .iter()
        .map(|(kind, bytes)| (*kind, bytes.as_slice()))
        .collect();
    assert_eq!(
        pictures,
        vec![(Kind::Png, one.as_slice()), (Kind::Jpeg, two.as_slice())]
    );
    assert_eq!(opened.manifest.id, "k7Qm2xPa");
    assert_eq!(
        (opened.manifest.version, opened.manifest.from),
        (3, Some(2))
    );
    assert!(holds_for(opened.wrote, &mario));
    assert!(holds_for(opened.sent, &mario));
}

#[test]
fn the_server_reads_every_limit_and_the_sender_without_the_key() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let mario = machine(1);
    let sealed = sealed(&key(9), &draft("hola", &pictures), Some(&mario.signer())).unwrap();
    let bytes = sealed.to_bytes();

    let arrived = read(&bytes).unwrap();
    let manifest = arrived.manifest();
    let kinds: Vec<Kind> = manifest.parts.iter().map(|one| one.kind).collect();
    assert_eq!(kinds, vec![Kind::Text, Kind::Signature, Kind::Png]);
    assert_eq!(manifest.parts[2].plain(), 300);
    assert!(holds_for(arrived.sender(&[]), &mario));
    assert!(
        !String::from_utf8_lossy(&bytes).contains("hola"),
        "the words travel sealed"
    );
}

#[test]
fn an_envelope_without_a_signature_opens_and_says_nobody_signed() {
    let sealed = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    let arrived = read(&sealed.to_bytes()).unwrap();
    let opened = open(&key(9), &arrived, &[]).unwrap();

    assert_eq!(opened.text.as_str(), "hola");
    assert!(opened.wrote.is_none() && opened.sent.is_none());
    assert!(!arrived.manifest().signed());
}

#[test]
fn another_key_never_opens_it() {
    let sealed = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    let arrived = read(&sealed.to_bytes()).unwrap();

    assert_eq!(open(&key(8), &arrived, &[]).err(), Some(Refused::Locked));
}

/// Where the sealed parts lie in the bytes: past the manifest, before the outer signature.
fn sealed_span(envelope: &Envelope) -> std::ops::Range<usize> {
    envelope.written.end..envelope.parts.last().unwrap().end
}

fn replaced(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let at = bytes
        .windows(from.len())
        .position(|one| one == from)
        .expect("the pattern is there");
    let mut out = bytes.to_vec();
    out[at..at + to.len()].copy_from_slice(to);
    out
}

#[test]
fn a_changed_byte_in_any_sealed_part_is_refused() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let sealed = sealed(
        &key(9),
        &draft("hola", &pictures),
        Some(&machine(1).signer()),
    )
    .unwrap();
    let bytes = sealed.to_bytes();
    let span = sealed_span(&sealed);
    assert!(span.len() > 300);

    for at in span.step_by(7) {
        let mut changed = bytes.clone();
        changed[at] ^= 1;
        let arrived = read(&changed).unwrap();
        assert_eq!(
            open(&key(9), &arrived, &[]).err(),
            Some(Refused::Locked),
            "byte {at}"
        );
        assert!(
            matches!(arrived.sender(&[]), Some(Verdict::Refused)),
            "byte {at}"
        );
    }
}

#[test]
fn a_manifest_changed_on_the_way_breaks_the_seal_and_the_sender() {
    let mario = machine(1);
    let bytes = sealed(&key(9), &draft("hola", &[]), Some(&mario.signer()))
        .unwrap()
        .to_bytes();
    let forged = replaced(&bytes, b"\"version\":3", b"\"version\":4");

    let arrived = read(&forged).unwrap();
    assert_eq!(arrived.manifest().version, 4);
    assert!(matches!(arrived.sender(&[]), Some(Verdict::Refused)));
    assert_eq!(open(&key(9), &arrived, &[]).err(), Some(Refused::Locked));
}

#[test]
fn a_picture_declared_as_another_kind_on_the_way_is_refused() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let bytes = sealed(&key(9), &draft("hola", &pictures), None)
        .unwrap()
        .to_bytes();
    let forged = replaced(&bytes, b"\"png\"", b"\"gif\"");

    let arrived = read(&forged).unwrap();
    assert_eq!(open(&key(9), &arrived, &[]).err(), Some(Refused::Locked));
}

#[test]
fn a_signature_taken_to_another_upload_does_not_hold() {
    let mario = machine(1);
    let one = sealed(&key(9), &draft("hola", &[]), Some(&mario.signer())).unwrap();
    let mut other = sealed(&key(9), &draft("chao", &[]), None).unwrap();
    other.sent = one.sent.clone();

    assert!(matches!(other.sender(&[]), Some(Verdict::Refused)));
}

#[test]
fn two_pictures_swapped_or_one_cut_off_are_refused() {
    let (one, two) = (png(1, 300), png(2, 300));
    let pictures = [(Kind::Png, one.as_slice()), (Kind::Png, two.as_slice())];
    let sealed = sealed(&key(9), &draft("hola", &pictures), None).unwrap();

    let mut swapped = sealed.clone();
    swapped.parts.swap(1, 2);
    assert_eq!(open(&key(9), &swapped, &[]).err(), Some(Refused::Locked));

    let mut cut = sealed.clone();
    cut.parts.pop();
    cut.manifest.parts.pop();
    assert!(open(&key(9), &cut, &[]).is_err());
}

#[test]
fn every_limit_is_held_when_sealing() {
    let big_text = "a".repeat(TEXT_AT_MOST + 1);
    assert_eq!(
        sealed(&key(9), &draft(&big_text, &[]), None).err(),
        Some(Refused::TextTooBig)
    );
    assert!(sealed(&key(9), &draft(&"a".repeat(TEXT_AT_MOST), &[]), None).is_ok());

    let big = png(1, PICTURE_AT_MOST + 1);
    assert_eq!(
        sealed(&key(9), &draft("x", &[(Kind::Png, &big)]), None).err(),
        Some(Refused::PictureTooBig)
    );

    let small = png(1, 10);
    let eleven: Vec<(Kind, &[u8])> = (0..=PICTURES_AT_MOST)
        .map(|_| (Kind::Png, small.as_slice()))
        .collect();
    assert_eq!(
        sealed(&key(9), &draft("x", &eleven), None).err(),
        Some(Refused::TooManyPictures)
    );

    let half = png(1, 450 * 1024);
    let five: Vec<(Kind, &[u8])> = (0..5).map(|_| (Kind::Png, half.as_slice())).collect();
    assert_eq!(
        sealed(&key(9), &draft("x", &five), None).err(),
        Some(Refused::PicturesTooBig)
    );
}

#[test]
fn a_file_passed_off_as_a_picture_never_leaves() {
    let pdf = b"%PDF-1.7 a document".to_vec();
    let disguised = png(1, 20);
    assert_eq!(
        sealed(&key(9), &draft("x", &[(Kind::Png, &pdf)]), None).err(),
        Some(Refused::NotAPicture)
    );
    assert_eq!(
        sealed(&key(9), &draft("x", &[(Kind::Jpeg, &disguised)]), None).err(),
        Some(Refused::NotAPicture)
    );
    assert_eq!(
        sealed(&key(9), &draft("x", &[(Kind::Text, &disguised)]), None).err(),
        Some(Refused::NotAPicture)
    );
}

#[test]
fn a_manifest_over_the_limits_is_refused_by_the_server_before_anything_is_kept() {
    let manifest = Manifest {
        v: SAID,
        id: "k7Qm2xPa".into(),
        version: 1,
        from: None,
        head: URL_SAFE_NO_PAD.encode([0u8; HEAD]),
        commit: URL_SAFE_NO_PAD.encode([0u8; 32]),
        parts: std::iter::once(Part {
            kind: Kind::Text,
            size: 20,
        })
        .chain((0..=PICTURES_AT_MOST).map(|_| Part {
            kind: Kind::Png,
            size: 30,
        }))
        .collect(),
    };
    let written = serde_json::to_vec(&manifest).unwrap();
    let mut bytes = MAGIC.to_vec();
    bytes.push(VERSION);
    bytes.extend_from_slice(&(written.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&written);

    assert_eq!(read(&bytes).err(), Some(Refused::TooManyPictures));
}

#[test]
fn a_version_must_come_after_the_one_it_was_written_on() {
    let mut twisted = draft("x", &[]);
    twisted.from = Some(3);
    assert_eq!(
        sealed(&key(9), &twisted, None).err(),
        Some(Refused::Damaged)
    );
    let mut first = draft("x", &[]);
    first.version = 1;
    first.from = None;
    assert!(sealed(&key(9), &first, None).is_ok());
}

#[test]
fn an_id_is_only_letters_digits_dashes_and_underscores() {
    for id in ["", "a/b", "dos palabras", &"x".repeat(ID_AT_MOST + 1)] {
        let mut odd = draft("x", &[]);
        odd.id = id;
        assert_eq!(
            sealed(&key(9), &odd, None).err(),
            Some(Refused::Damaged),
            "{id:?}"
        );
    }
}

#[test]
fn a_revoked_machine_reads_as_revoked() {
    let mario = machine(1);
    let sealed = sealed(&key(9), &draft("hola", &[]), Some(&mario.signer())).unwrap();
    let taken_back = mario
        .root
        .revoke(&mario.key.public(), Timestamp::from_second(2_000).unwrap());

    let opened = open(&key(9), &sealed, std::slice::from_ref(&taken_back)).unwrap();
    assert!(matches!(opened.wrote, Some(Verdict::Revoked { .. })));
    assert!(matches!(
        sealed.sender(&[taken_back]),
        Some(Verdict::Revoked { .. })
    ));
}

#[test]
fn a_machine_whose_certificate_is_another_key_s_cannot_sign() {
    let mario = machine(1);
    let stranger = ShareKey::from_bytes(&[42; 32]);
    let borrowed = Signer {
        key: &stranger,
        certificate: &mario.certificate,
        at: jiff::Timestamp::from_second(1_000).unwrap(),
        name: None,
    };
    assert_eq!(
        sealed(&key(9), &draft("hola", &[]), Some(&borrowed)).err(),
        Some(Refused::Unsigned)
    );
}

#[test]
fn bytes_not_sealed_by_tisty_share_or_by_a_newer_one_say_so() {
    assert_eq!(read(b"# hola").err(), Some(Refused::Foreign));
    let mut bytes = sealed(&key(9), &draft("hola", &[]), None)
        .unwrap()
        .to_bytes();
    bytes[4] = LAID + 1;
    assert_eq!(read(&bytes).err(), Some(Refused::Newer));
    assert_eq!(read(&bytes[..3]).err(), Some(Refused::Foreign));
}

#[test]
fn trailing_or_missing_bytes_are_refused() {
    let bytes = sealed(&key(9), &draft("hola", &[]), None)
        .unwrap()
        .to_bytes();
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(read(&longer).err(), Some(Refused::Damaged));
    assert_eq!(
        read(&bytes[..bytes.len() - 1]).err(),
        Some(Refused::Damaged)
    );
}

#[test]
fn the_link_key_travels_as_text_and_back() {
    let minted = LinkKey::minted().unwrap();
    let said = minted.to_text();
    assert_eq!(said.len(), 43);
    let back = LinkKey::from_text(&said).unwrap();
    assert_eq!(back.to_text().as_str(), said.as_str());
    assert!(LinkKey::from_text("short").is_none());
}

#[test]
fn two_seals_of_the_same_words_never_look_alike() {
    let one = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    let two = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    assert_ne!(one.to_bytes(), two.to_bytes());
    assert_ne!(one.manifest.head, two.manifest.head);
}

#[test]
fn the_limits_unless_a_server_says_otherwise_are_decision_five() {
    let ours = Limits::default();
    assert_eq!(
        (ours.text, ours.picture, ours.pictures, ours.all_pictures),
        (512 * 1024, 512 * 1024, 10, 2 * 1024 * 1024)
    );
    assert_eq!(
        ours.kinds,
        vec![Kind::Png, Kind::Jpeg, Kind::Webp, Kind::Gif]
    );
}

#[test]
fn a_server_with_its_own_limits_holds_them_both_ways() {
    let tight = Limits {
        text: 10,
        html: 10,
        picture: 100,
        pictures: 1,
        all_pictures: 100,
        kinds: vec![Kind::Png],
    };
    let small = png(1, 50);
    let one = [(Kind::Png, small.as_slice())];
    assert!(seal(&key(9), &draft("hola", &one), None, &tight).is_ok());
    assert_eq!(
        seal(&key(9), &draft("demasiado texto", &[]), None, &tight).err(),
        Some(Refused::TextTooBig)
    );
    let two = [(Kind::Png, small.as_slice()), (Kind::Png, small.as_slice())];
    assert_eq!(
        seal(&key(9), &draft("x", &two), None, &tight).err(),
        Some(Refused::TooManyPictures)
    );

    // What one server took, a tighter one refuses before it keeps anything.
    let bytes = sealed(&key(9), &draft("hola", &[(Kind::Png, &png(1, 300))]), None)
        .unwrap()
        .to_bytes();
    assert_eq!(
        Envelope::read(bytes.clone(), &tight).err(),
        Some(Refused::PictureTooBig)
    );
}

#[test]
fn a_server_that_raised_its_limits_takes_more() {
    let roomy = Limits {
        text: 2 * 1024 * 1024,
        ..Limits::default()
    };
    let long = "a".repeat(TEXT_AT_MOST * 2);
    let bytes = seal(&key(9), &draft(&long, &[]), None, &roomy)
        .unwrap()
        .to_bytes();

    assert_eq!(read(&bytes).err(), Some(Refused::TextTooBig));
    let arrived = Envelope::read(bytes.clone(), &roomy).unwrap();
    assert_eq!(open(&key(9), &arrived, &[]).unwrap().text.len(), long.len());
}

#[test]
fn pictures_turned_off_or_a_kind_not_taken_are_refused() {
    let picture = png(1, 50);
    let one = [(Kind::Png, picture.as_slice())];
    let off = Limits {
        pictures: 0,
        ..Limits::default()
    };
    assert_eq!(
        seal(&key(9), &draft("x", &one), None, &off).err(),
        Some(Refused::TooManyPictures)
    );
    assert!(seal(&key(9), &draft("x", &[]), None, &off).is_ok());

    let photos_only = Limits {
        kinds: vec![Kind::Jpeg],
        ..Limits::default()
    };
    assert_eq!(
        seal(&key(9), &draft("x", &one), None, &photos_only).err(),
        Some(Refused::KindRefused)
    );
}

#[test]
fn a_server_says_its_limits_as_json_and_tisty_reads_them_back() {
    let said = serde_json::to_string(&Limits::default()).unwrap();
    assert!(said.contains("\"kinds\":[\"png\",\"jpeg\",\"webp\",\"gif\"]"));
    let back: Limits = serde_json::from_str(&said).unwrap();
    assert_eq!(back, Limits::default());
}

#[test]
fn an_envelope_says_which_key_it_was_sealed_for_and_no_other_key_opens_it() {
    let sealed = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    let head = sealed.manifest().head().unwrap();
    assert_eq!(
        sealed.manifest().commitment(),
        Some(key(9).commitment(&head))
    );
    assert_ne!(key(9).commitment(&head), key(8).commitment(&head));

    // A tag that held under another key would still meet the commitment first.
    let mut claimed = sealed.clone();
    claimed.manifest.commit = URL_SAFE_NO_PAD.encode(key(8).commitment(&head));
    assert_eq!(open(&key(9), &claimed, &[]).err(), Some(Refused::Locked));
    assert_eq!(open(&key(8), &claimed, &[]).err(), Some(Refused::Locked));
}

#[test]
fn a_manifest_without_its_commitment_is_damaged() {
    let bytes = sealed(&key(9), &draft("hola", &[]), None)
        .unwrap()
        .to_bytes();
    let at = bytes
        .windows(9)
        .position(|one| one == b"\"commit\":")
        .unwrap();
    let mut forged = bytes.clone();
    // The value's first character becomes a quote, so the commitment is empty and the length stays the same.
    forged[at + 9..at + 11].copy_from_slice(b"\"\"");
    let end = forged[at + 11..]
        .iter()
        .position(|one| *one == b'"')
        .unwrap()
        + at
        + 11;
    forged[at + 11..=end].fill(b' ');

    assert_eq!(read(&forged).err(), Some(Refused::Damaged));
}

#[test]
fn sizes_near_the_largest_number_never_overflow_a_server_with_no_limits() {
    let unlimited = Limits {
        text: u64::MAX,
        picture: u64::MAX,
        pictures: u64::MAX,
        all_pictures: u64::MAX - 1,
        ..Limits::default()
    };
    let manifest = Manifest {
        v: SAID,
        id: "k7Qm2xPa".into(),
        version: 1,
        from: None,
        head: URL_SAFE_NO_PAD.encode([0u8; HEAD]),
        commit: URL_SAFE_NO_PAD.encode([0u8; 32]),
        parts: vec![
            Part {
                kind: Kind::Text,
                size: 20,
            },
            Part {
                kind: Kind::Png,
                size: u64::MAX,
            },
            Part {
                kind: Kind::Png,
                size: u64::MAX,
            },
        ],
    };
    assert_eq!(manifest.holds(&unlimited), Err(Refused::PicturesTooBig));
}

#[test]
fn a_kind_only_a_later_tisty_knows_is_passed_over_in_a_server_s_limits() {
    let said = r#"{"text":1,"picture":2,"pictures":3,"all_pictures":4,"kinds":["avif","png",{"odd":1},"jpeg"]}"#;
    let read: Limits = serde_json::from_str(said).unwrap();
    assert_eq!(read.kinds, vec![Kind::Png, Kind::Jpeg]);
    assert_eq!(
        (read.text, read.picture, read.pictures, read.all_pictures),
        (1, 2, 3, 4)
    );
}

#[test]
fn reading_keeps_the_bytes_it_was_given_and_hands_them_back_whole() {
    let bytes = sealed(&key(9), &draft("hola", &[]), Some(&machine(1).signer()))
        .unwrap()
        .to_bytes();
    let arrived = read(&bytes).unwrap();
    assert_eq!(arrived.as_bytes(), bytes.as_slice());
    assert!(arrived.sender(&[]).is_some());
}

#[test]
fn the_outer_signature_is_written_one_way_only() {
    let bytes = sealed(&key(9), &draft("hola", &[]), Some(&machine(1).signer()))
        .unwrap()
        .to_bytes();
    let since = bytes
        .windows(9)
        .rposition(|one| one == b"\"since\":\"")
        .unwrap();
    let zone = since + bytes[since..].iter().position(|one| *one == b'Z').unwrap();
    let mut lower = bytes.clone();
    // A lower-case zone reads as the same second, so the same signature would have a second spelling.
    lower[zone] = b'z';

    assert_eq!(read(&lower).err(), Some(Refused::Damaged));
}

#[test]
fn a_manifest_too_long_for_any_reader_is_refused_before_it_is_sealed() {
    let roomy = Limits {
        pictures: 10_000,
        all_pictures: u64::MAX,
        ..Limits::default()
    };
    let tiny = png(1, 9);
    let many: Vec<(Kind, &[u8])> = (0..1_000).map(|_| (Kind::Png, tiny.as_slice())).collect();

    assert_eq!(
        seal(&key(9), &draft("x", &many), None, &roomy).err(),
        Some(Refused::TooManyPictures)
    );
}

#[test]
fn a_field_a_server_leaves_out_takes_tisty_s_own() {
    let older: Limits = serde_json::from_str(r#"{"text":100,"kinds":["png"]}"#).unwrap();
    assert_eq!(older.text, 100);
    assert_eq!(older.kinds, vec![Kind::Png]);
    assert_eq!(older.pictures, Limits::default().pictures);

    let newer: Limits = serde_json::from_str(r#"{"text":100,"videos":3}"#).unwrap();
    assert_eq!(newer.kinds, Limits::default().kinds);
}

#[test]
fn a_signature_carrying_more_than_tisty_writes_is_refused_until_the_version_says_so() {
    let bytes = sealed(&key(9), &draft("hola", &[]), Some(&machine(1).signer()))
        .unwrap()
        .to_bytes();
    // A field the signature does not have, as a later Tisty might add, with its length written to match.
    let said = framed_len(&bytes);
    let mut longer = bytes[..bytes.len() - 1].to_vec();
    longer.extend_from_slice(br#","x":1}"#);
    let at = bytes.len() - 4 - said;
    longer[at..at + 4].copy_from_slice(&((said + 6) as u32).to_be_bytes());

    assert_eq!(read(&longer).err(), Some(Refused::Damaged));
}

/// The length of the signature at the end of the bytes, read back from where it was written.
fn framed_len(bytes: &[u8]) -> usize {
    let arrived = read(bytes).unwrap();
    bytes.len() - arrived.parts.last().unwrap().end - 4
}

#[test]
fn the_digest_is_the_same_whether_sealed_here_or_read_there() {
    let sealed = sealed(&key(9), &draft("hola", &[]), Some(&machine(1).signer())).unwrap();
    let arrived = read(&sealed.to_bytes()).unwrap();

    assert_eq!(sealed.digest(), arrived.digest());
    assert!(matches!(arrived.sender(&[]), Some(Verdict::Holds { .. })));
}

#[test]
fn the_writer_signs_the_id_the_moment_and_the_name_they_chose() {
    let mario = machine(1);
    let signer = Signer {
        name: Some("Mario Hidalgo"),
        ..mario.signer()
    };
    let sealed = sealed(&key(9), &draft("Hola", &[]), Some(&signer)).unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

    assert!(holds_for(opened.wrote, &mario));
    assert_eq!(
        opened.written,
        Some(Written {
            at: Timestamp::from_second(1_000).unwrap(),
            name: Some("Mario Hidalgo".into()),
        })
    );
}

#[test]
fn words_signed_for_another_link_are_not_the_writer_sharing_them_here() {
    let mario = machine(1);
    let elsewhere = Draft {
        id: "otro",
        ..draft("Hola", &[])
    };
    let carried = wrote(&mario.signer(), &elsewhere, None).unwrap();
    let thief = machine(5);
    let sealed = sealed_with(
        &key(9),
        &draft("Hola", &[]),
        Some(&carried),
        None,
        Some(&thief.signer()),
        &Limits::default(),
    )
    .unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

    assert_eq!(opened.wrote, Some(Verdict::Refused));
    assert!(holds_for(opened.sent, &thief));
}

#[test]
fn words_another_key_wrote_are_not_vouched_for_by_the_key_that_sent_them() {
    // A thief with a key its owner took back signs the words with it and sends them with a fresh one of their own:
    // the server only tells of revocations for the sender, so the stolen writer must never read as holding.
    let stolen = machine(1);
    let words = wrote(&stolen.signer(), &draft("Hola", &[]), None).unwrap();
    let thief = machine(5);
    let sealed = sealed_with(
        &key(9),
        &draft("Hola", &[]),
        Some(&words),
        None,
        Some(&thief.signer()),
        &Limits::default(),
    )
    .unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

    assert_eq!(opened.wrote, Some(Verdict::Refused));
    assert!(holds_for(opened.sent, &thief));
}

#[test]
fn a_name_changed_after_signing_does_not_hold() {
    let mario = machine(1);
    let signer = Signer {
        name: Some("Mario"),
        ..mario.signer()
    };
    let honest = wrote(&signer, &draft("Hola", &[]), None).unwrap();
    let mut wrote_: Wrote = serde_json::from_slice(&honest).unwrap();
    wrote_.name = Some("Ana".into());
    let changed = serde_json::to_vec(&wrote_).unwrap();
    let sealed = sealed_with(
        &key(9),
        &draft("Hola", &[]),
        Some(&changed),
        None,
        Some(&mario.signer()),
        &Limits::default(),
    )
    .unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

    assert_eq!(opened.wrote, Some(Verdict::Refused));
}

#[test]
fn a_name_is_a_readable_line_of_at_most_eighty_characters_with_nothing_unseen() {
    let mario = machine(1);
    let long = "x".repeat(NAME_AT_MOST + 1);
    for name in [
        "",
        "   ",
        " Mario",
        "una\nlínea",
        "\u{200B}",
        "Ana\u{202E}zeréP",
        "\u{3164}",
        "Ana\u{2028}Pérez",
        "12345 67890 12345 67890",
        "12345 67890 12345 6789O",
        "Ana\u{180B}",
        "Ana\u{17B4}",
        "Ana\u{1D173}",
        "Ana\u{E0041}",
        long.as_str(),
    ] {
        let signer = Signer {
            name: Some(name),
            ..mario.signer()
        };
        assert_eq!(
            sealed(&key(9), &draft("Hola", &[]), Some(&signer)).err(),
            Some(Refused::NameTooLong),
            "{name:?}"
        );
    }
}

#[test]
fn a_name_of_any_alphabet_up_to_eighty_characters_is_signed() {
    let mario = machine(1);
    let longest = "日".repeat(NAME_AT_MOST);
    for name in [
        "Mario Hidalgo",
        "José Núñez",
        "王小明",
        "R2D2",
        "Sala 101",
        longest.as_str(),
    ] {
        let signer = Signer {
            name: Some(name),
            ..mario.signer()
        };
        assert!(
            sealed(&key(9), &draft("Hola", &[]), Some(&signer)).is_ok(),
            "{name}"
        );
    }
}

fn cited(doc: &str, id: &str, page: Option<(u32, u32)>) -> Cited {
    Cited {
        doc: doc.into(),
        id: id.into(),
        key: key(4).to_text().to_string(),
        title: format!("Sobre {doc}"),
        page,
    }
}

#[test]
fn what_the_words_cite_travels_sealed_between_the_signature_and_the_pictures() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let list = [
        cited("guia-2", "pag2Xa", Some((2, 3))),
        cited("notas", "nts9Qe", None),
    ];
    let mario = machine(1);
    let draft = Draft {
        cited: &list,
        html: None,
        ..draft("![Página 2](tisty:doc/guia-2)", &pictures)
    };
    let sealed = sealed(&key(9), &draft, Some(&mario.signer())).unwrap();
    let arrived = read(&sealed.to_bytes()).unwrap();
    let kinds: Vec<Kind> = arrived
        .manifest()
        .parts
        .iter()
        .map(|one| one.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![Kind::Text, Kind::Signature, Kind::Cited, Kind::Png]
    );
    // A Tisty from before the list reads it as newer, never as damaged.
    assert_eq!(arrived.manifest().v, CITING);
    // The server sees that something is cited, never what or under which key.
    assert!(!String::from_utf8_lossy(&sealed.to_bytes()).contains("pag2Xa"));

    let opened = open(&key(9), &arrived, &[]).unwrap();
    assert_eq!(opened.cited, list);
    assert_eq!(opened.pictures.len(), 1);
    assert!(holds_for(opened.wrote, &mario));
}

#[test]
fn an_envelope_that_cites_nothing_is_what_it_always_was() {
    let sealed = sealed(&key(9), &draft("hola", &[]), None).unwrap();
    let arrived = read(&sealed.to_bytes()).unwrap();
    assert_eq!(arrived.manifest().parts.len(), 1);
    assert_eq!(arrived.manifest().v, SAID);
    assert!(open(&key(9), &arrived, &[]).unwrap().cited.is_empty());
}

#[test]
fn the_writer_signs_what_the_words_cite_so_nobody_swaps_where_they_lead() {
    let mario = machine(1);
    let honest = [cited("notas", "nts9Qe", None)];
    let swapped = [cited("notas", "trampa", None)];
    let signed_for = Draft {
        cited: &honest,
        html: None,
        ..draft("Hola", &[])
    };
    let words = wrote(
        &mario.signer(),
        &signed_for,
        cited_bytes(&honest)
            .unwrap()
            .as_ref()
            .map(|said| said.as_slice()),
    )
    .unwrap();
    let sent = Draft {
        cited: &swapped,
        html: None,
        ..draft("Hola", &[])
    };
    let sealed = sealed_with(
        &key(9),
        &sent,
        Some(&words),
        cited_bytes(&swapped)
            .unwrap()
            .as_ref()
            .map(|said| said.as_slice()),
        Some(&mario.signer()),
        &Limits::default(),
    )
    .unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

    assert_eq!(opened.wrote, Some(Verdict::Refused));
}

#[test]
fn a_cited_document_that_could_not_be_opened_or_named_is_never_sealed() {
    let mut bad_key = cited("notas", "nts9Qe", None);
    bad_key.key = "corta".into();
    let too_many: Vec<Cited> = (0..=CITED_AT_MOST)
        .map(|n| cited(&format!("d{n}"), &format!("id{n}"), None))
        .collect();
    for list in [
        vec![bad_key],
        vec![cited("notas", "no/vale", None)],
        vec![cited("", "nts9Qe", None)],
        vec![cited("notas", "nts9Qe", Some((4, 3)))],
        vec![cited("notas", "nts9Qe", Some((0, 3)))],
        too_many,
    ] {
        let draft = Draft {
            cited: &list,
            html: None,
            ..draft("Hola", &[])
        };
        assert_eq!(sealed(&key(9), &draft, None).err(), Some(Refused::Damaged));
    }
}

fn drawn<'a>(text: &'a str, html: &'a str, pictures: &'a [(Kind, &'a [u8])]) -> Draft<'a> {
    Draft {
        html: Some(html),
        ..draft(text, pictures)
    }
}

#[test]
fn a_drawn_page_travels_sealed_beside_the_words_laid_out_with_an_index() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let mario = machine(1);
    let html = "<h1>Hola</h1><p><img src=\"tisty:picture/0\"></p>";
    let sealed = sealed(
        &key(9),
        &drawn("# Hola", html, &pictures),
        Some(&mario.signer()),
    )
    .unwrap();
    let bytes = sealed.to_bytes();
    assert_eq!(bytes[4], LAID);
    // The page is sealed: the server sees that one is there, never what it says.
    assert!(!String::from_utf8_lossy(&bytes).contains("Hola"));

    let arrived = read(&bytes).unwrap();
    assert_eq!(arrived.manifest().v, RENDERED);
    let kinds: Vec<Kind> = arrived
        .manifest()
        .parts
        .iter()
        .map(|one| one.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![Kind::Text, Kind::Signature, Kind::Html, Kind::Png]
    );
    assert!(holds_for(arrived.sender(&[]), &mario));

    let opened = open(&key(9), &arrived, &[]).unwrap();
    assert_eq!(opened.html.as_deref().map(|one| one.as_str()), Some(html));
    assert_eq!(opened.text.as_str(), "# Hola");
    assert_eq!(opened.pictures.len(), 1);
    assert!(holds_for(opened.wrote, &mario));
}

#[test]
fn the_sender_is_known_from_the_bytes_before_the_parts() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let mario = machine(1);
    let sealed = sealed(
        &key(9),
        &drawn("hola", "<p>hola</p>", &pictures),
        Some(&mario.signer()),
    )
    .unwrap();
    // The digest the sender signs covers the manifest and the index only, which come before every part.
    let first_part = sealed.parts[0].start;
    let mut over = Sha256::new();
    over.update(INDEXED);
    for range in [sealed.written.clone(), sealed.index.clone().unwrap()] {
        assert!(range.end <= first_part);
        over.update((range.len() as u64).to_be_bytes());
        over.update(&sealed.as_bytes()[range]);
    }
    assert_eq!(sealed.digest(), <[u8; 32]>::from(over.finalize()));
}

#[test]
fn a_part_that_is_not_the_one_its_index_hashes_is_refused() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let sealed = sealed(&key(9), &drawn("hola", "<p>hola</p>", &pictures), None).unwrap();
    let mut bytes = sealed.to_bytes();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    assert_eq!(read(&bytes).err(), Some(Refused::Damaged));
}

#[test]
fn a_picture_swapped_by_someone_who_holds_the_key_does_not_hold_for_the_writer() {
    let mario = machine(1);
    let honest = png(1, 300);
    let other = png(2, 300);
    let written = [(Kind::Png, honest.as_slice())];
    let swapped = [(Kind::Png, other.as_slice())];
    let html = "<p>hola</p>";
    let words = wrote(&mario.signer(), &drawn("hola", html, &written), None).unwrap();
    let sealed = sealed_with(
        &key(9),
        &drawn("hola", html, &swapped),
        Some(&words),
        None,
        Some(&mario.signer()),
        &Limits::default(),
    )
    .unwrap();
    let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();
    assert_eq!(opened.wrote, Some(Verdict::Refused));
}

#[test]
fn a_drawn_page_past_what_the_server_takes_is_never_sealed() {
    let tight = Limits {
        html: 4,
        ..Limits::default()
    };
    let draft = drawn("hola", "<p>hola</p>", &[]);
    assert_eq!(
        seal(&key(9), &draft, None, &tight).err(),
        Some(Refused::HtmlTooBig)
    );
}

/// Seals what someone holding the key would: the writer's signature over one draft, carried by another.
fn resealed(written: &Draft, carried: &Draft, by: &Machine) -> Envelope {
    let words = wrote(&by.signer(), written, None).unwrap();
    sealed_with(
        &key(9),
        carried,
        Some(&words),
        None,
        Some(&by.signer()),
        &Limits::default(),
    )
    .unwrap()
}

#[test]
fn a_page_or_its_pictures_changed_by_someone_who_holds_the_key_do_not_hold_for_the_writer() {
    let mario = machine(1);
    let one = png(1, 300);
    let two = png(2, 300);
    let both = [(Kind::Png, one.as_slice()), (Kind::Png, two.as_slice())];
    let reordered = [(Kind::Png, two.as_slice()), (Kind::Png, one.as_slice())];
    let fewer = [(Kind::Png, one.as_slice())];
    let more = [
        (Kind::Png, one.as_slice()),
        (Kind::Png, two.as_slice()),
        (Kind::Png, one.as_slice()),
    ];
    let written = drawn("hola", "<p>hola</p>", &both);
    let changed = [
        drawn("hola", "<p>adiós</p>", &both),
        drawn("hola", "<p>hola</p>", &reordered),
        drawn("hola", "<p>hola</p>", &fewer),
        drawn("hola", "<p>hola</p>", &more),
    ];
    for carried in &changed {
        let sealed = resealed(&written, carried, &mario);
        let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();
        assert_eq!(opened.wrote, Some(Verdict::Refused));
    }
}

#[test]
fn a_writer_s_signature_never_crosses_between_a_drawn_envelope_and_a_plain_one() {
    let mario = machine(1);
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let plain = draft("hola", &pictures);
    let with_page = drawn("hola", "<p>hola</p>", &pictures);
    for (written, carried) in [(&with_page, &plain), (&plain, &with_page)] {
        let sealed = resealed(written, carried, &mario);
        let opened = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();
        assert_eq!(opened.wrote, Some(Verdict::Refused));
    }
}

#[test]
fn the_format_byte_must_say_whether_the_envelope_carries_an_index() {
    let mut plain = sealed(&key(9), &draft("hola", &[]), None)
        .unwrap()
        .to_bytes();
    plain[4] = LAID;
    assert_eq!(read(&plain).err(), Some(Refused::Damaged));

    let mut laid = sealed(&key(9), &drawn("hola", "<p>hola</p>", &[]), None)
        .unwrap()
        .to_bytes();
    laid[4] = VERSION;
    assert_eq!(read(&laid).err(), Some(Refused::Damaged));
}

#[test]
fn an_index_changed_cut_short_or_framed_wrong_is_refused() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let sealed = sealed(&key(9), &drawn("hola", "<p>hola</p>", &pictures), None).unwrap();
    let bytes = sealed.to_bytes();
    let index = sealed.index.clone().unwrap();

    let mut flipped = bytes.clone();
    flipped[index.start] ^= 1;
    assert_eq!(read(&flipped).err(), Some(Refused::Damaged));

    for length in [index.len() - 1, index.len() + 1] {
        let mut framed = bytes.clone();
        framed[index.start - 4..index.start].copy_from_slice(&(length as u32).to_be_bytes());
        assert_eq!(read(&framed).err(), Some(Refused::Damaged));
    }

    let cut = bytes[..index.start + 10].to_vec();
    assert_eq!(read(&cut).err(), Some(Refused::Damaged));
}

#[test]
fn a_drawn_page_comes_only_where_and_when_the_manifest_says() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let list = [cited("notas", "nts9Qe", None)];
    let page = Draft {
        cited: &list,
        ..drawn("hola", "<p>hola</p>", &pictures)
    };
    let manifest = sealed(&key(9), &page, None).unwrap().manifest().clone();
    let limits = Limits::default();
    assert_eq!(manifest.holds(&limits), Ok(()));

    let older = Manifest {
        v: CITING,
        ..manifest.clone()
    };
    assert_eq!(older.holds(&limits), Err(Refused::Damaged));

    let mut without = manifest.clone();
    without.parts.retain(|one| one.kind != Kind::Html);
    assert_eq!(without.holds(&limits), Err(Refused::Damaged));

    let mut before_cited = manifest.clone();
    before_cited.parts.swap(1, 2);
    assert_eq!(before_cited.holds(&limits), Err(Refused::Damaged));
}

#[test]
fn a_drawn_page_opens_signed_or_not_with_or_without_citing_and_pictures() {
    let mario = machine(1);
    let list = [cited("notas", "nts9Qe", None)];
    let page = Draft {
        cited: &list,
        ..drawn("hola", "<p>hola</p>", &[])
    };
    for by in [None, Some(mario.signer())] {
        let sealed = sealed(&key(9), &page, by.as_ref()).unwrap();
        let arrived = read(&sealed.to_bytes()).unwrap();
        assert_eq!(arrived.manifest().parts.last().unwrap().kind, Kind::Html);
        let opened = open(&key(9), &arrived, &[]).unwrap();
        assert_eq!(opened.cited, list);
        assert_eq!(
            opened.html.as_deref().map(|one| one.as_str()),
            Some("<p>hola</p>")
        );
        match by {
            Some(_) => assert!(holds_for(opened.wrote, &mario)),
            None => assert_eq!(opened.wrote, None),
        }
    }
}

#[test]
fn a_signed_drawn_page_carries_as_many_pictures_as_a_roomier_server_takes() {
    let roomy = Limits {
        pictures: 60,
        ..Limits::default()
    };
    let tiny = png(1, 9);
    let many: Vec<(Kind, &[u8])> = (0..60).map(|_| (Kind::Png, tiny.as_slice())).collect();
    let mario = machine(1);
    let signer = Signer {
        name: Some("Una firma de ochenta caracteres para medir el peso del índice de imágenes."),
        ..mario.signer()
    };
    let sealed = seal(
        &key(9),
        &drawn("hola", "<p>hola</p>", &many),
        Some(&signer),
        &roomy,
    )
    .unwrap();
    let arrived = Envelope::read(sealed.to_bytes(), &roomy).unwrap();
    let opened = open(&key(9), &arrived, &[]).unwrap();
    assert_eq!(opened.pictures.len(), 60);
    assert!(holds_for(opened.wrote, &mario));
}

#[test]
fn a_server_that_says_nothing_of_drawn_pages_takes_none() {
    let older: Limits = serde_json::from_str(r#"{"text":100}"#).unwrap();
    assert_eq!(older.html, 0);
    assert_eq!(
        seal(&key(9), &drawn("hola", "<p>hola</p>", &[]), None, &older).err(),
        Some(Refused::HtmlTooBig)
    );
}

#![no_main]

use arbitrary::Arbitrary;
use jiff::Timestamp;
use libfuzzer_sys::fuzz_target;
use tisty_share_proto::envelope::{self, Draft, Envelope, Kind, LinkKey, Signer};
use tisty_share_proto::identity::{Root, ShareKey, Verdict};
use tisty_share_proto::limits::Limits;

#[derive(Arbitrary, Debug)]
struct Input {
    text: String,
    pictures: Vec<Vec<u8>>,
    signed: bool,
    at: usize,
    flip: u8,
    cut: bool,
}

fn png(rest: &[u8]) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(rest);
    bytes
}

fuzz_target!(|input: Input| {
    let key = LinkKey::from_bytes(&[7; 32]);
    let root = Root::from_bytes(&[1; 32]);
    let share = ShareKey::from_bytes(&[2; 32]);
    let certificate = root.certify(&share.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &share,
        certificate: &certificate,
        at: Timestamp::from_second(2_000).unwrap(),
        name: Some("Fuzz"),
    };
    let pictures: Vec<Vec<u8>> = input.pictures.iter().take(3).map(|one| png(one)).collect();
    let shown: Vec<(Kind, &[u8])> = pictures
        .iter()
        .map(|one| (Kind::Png, one.as_slice()))
        .collect();
    let draft = Draft {
        id: "fuzzed",
        version: 2,
        from: Some(1),
        text: &input.text,
        pictures: &shown,
    };
    let Ok(sealed) = envelope::seal(
        &key,
        &draft,
        input.signed.then_some(&signer),
        &Limits::default(),
    ) else {
        return;
    };
    let mut bytes = sealed.to_bytes();
    let opened = envelope::open(
        &key,
        &Envelope::read(bytes.clone(), &Limits::default()).unwrap(),
        &[],
    )
    .unwrap();
    assert_eq!(opened.text.as_str(), input.text);
    assert_eq!(opened.pictures.len(), pictures.len());

    let at = input.at % bytes.len();
    if input.cut {
        bytes.truncate(at);
    } else {
        bytes[at] ^= input.flip.max(1);
    }
    // A change has to show somewhere: it is refused, it does not open, or its sender no longer holds.
    let Ok(read) = Envelope::read(bytes, &Limits::default()) else {
        return;
    };
    let unopened = envelope::open(&key, &read, &[]).is_err();
    let unsent = !matches!(read.sender(&[]), Some(Verdict::Holds { .. }));
    assert!(unopened || (input.signed && unsent));
});

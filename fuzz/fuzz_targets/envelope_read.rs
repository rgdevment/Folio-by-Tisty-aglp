#![no_main]

use libfuzzer_sys::fuzz_target;
use tisty_share_proto::envelope::{self, Envelope, LinkKey};
use tisty_share_proto::limits::Limits;

// Whatever a stranger uploads reaches this before anything is stored, so it may refuse but never fall over.
fuzz_target!(|bytes: &[u8]| {
    let Ok(read) = Envelope::read(bytes.to_vec(), &Limits::default()) else {
        return;
    };
    assert!(read.manifest().holds(&Limits::default()).is_ok());
    let again =
        Envelope::read(read.to_bytes(), &Limits::default()).expect("what was read reads again");
    assert_eq!(again.manifest(), read.manifest());
    assert_eq!(read.as_bytes(), bytes, "what was read is kept whole");
    assert_eq!(again.digest(), read.digest());
    let _ = read.sender(&[]);
    let _ = envelope::open(&LinkKey::from_bytes(&[7; 32]), &read, &[]);
});

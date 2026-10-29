use super::*;

/// Hands back the bytes it was given, in order, and then nothing.
struct Given(Vec<u8>);

impl Randomness for Given {
    fn fill(&mut self, into: &mut [u8]) -> bool {
        if self.0.len() < into.len() {
            return false;
        }
        into.copy_from_slice(&self.0.drain(..into.len()).collect::<Vec<_>>());
        true
    }
}

const FAST: Slowness = Slowness { log_n: 4, r: 8 };

#[test]
fn an_id_is_eight_letters_or_digits() {
    let id = minted_id(&mut Given((0..8).collect())).unwrap();
    assert_eq!(id, "01234567");
    let id = minted_id(&mut Given(vec![61, 10, 36, 9, 0, 0, 0, 0])).unwrap();
    assert_eq!(id, "zAa90000");
}

#[test]
fn a_byte_that_would_favour_some_letters_is_drawn_again() {
    // 248 and above would land on the first eight characters more often than the rest.
    let id = minted_id(&mut Given(vec![248, 255, 1, 2, 3, 4, 5, 6, 7, 8])).unwrap();
    assert_eq!(id, "12345678");
}

#[test]
fn nothing_is_minted_without_randomness() {
    assert!(minted_id(&mut Given(vec![1, 2])).is_none());
    assert!(minted_token(&mut Given(vec![0; 31])).is_none());
}

#[test]
fn a_token_carries_256_bits_and_only_its_hash_is_kept() {
    let token = minted_token(&mut Given(vec![7; 32])).unwrap();
    assert_eq!(token.len(), 43);
    assert_eq!(hashed(&token), hashed(&token));
    assert_ne!(hashed(&token), hashed("another"));
}

#[test]
fn a_gate_opens_with_its_password_and_no_other() {
    let held = gate("perro azul", [3; 16], FAST).unwrap();
    assert!(opens(&held, "perro azul"));
    assert!(!opens(&held, "perro azul "));
    assert!(!opens(&held, ""));
    assert_eq!(held.slowness, FAST);
}

#[test]
fn the_same_password_under_another_salt_reads_differently() {
    let one = gate("perro azul", [3; 16], FAST).unwrap();
    let two = gate("perro azul", [4; 16], FAST).unwrap();
    assert_ne!(one.digest, two.digest);
}

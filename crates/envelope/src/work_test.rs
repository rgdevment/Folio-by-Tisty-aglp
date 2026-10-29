use super::*;

fn asked(bits: u8) -> Challenge {
    Challenge {
        salt: "c2FsdA".into(),
        seed: "c2VlZA".into(),
        bits,
        expires: 0,
    }
}

#[test]
fn a_solved_challenge_meets_its_bits_and_nothing_else_does() {
    let proof = solve(&asked(12)).unwrap();
    assert!(meets(&proof.challenge, proof.nonce));
    // The first nonce that meets it is the one found, so every one before it falls short.
    assert!((0..proof.nonce).all(|nonce| !meets(&proof.challenge, nonce)));
}

#[test]
fn a_proof_for_one_seed_does_not_answer_another() {
    let proof = solve(&asked(16)).unwrap();
    let other = Challenge {
        seed: "b3RybyBzZWVk".into(),
        ..asked(16)
    };
    assert!(!meets(&other, proof.nonce));
}

#[test]
fn no_work_is_asked_at_zero_bits_and_too_much_is_refused() {
    assert_eq!(solve(&asked(0)).unwrap().nonce, 0);
    assert!(solve(&asked(BITS_AT_MOST + 1)).is_none());
}

#[test]
fn the_zeros_are_counted_across_bytes() {
    assert_eq!(leading_zeros(&[0, 0, 0x0f, 0xff]), 20);
    assert_eq!(leading_zeros(&[0x80]), 0);
    assert_eq!(leading_zeros(&[0, 0]), 16);
}

use tisty_share_proto::work::{Challenge, Proof, meets};

use super::solved;

fn challenge(bits: u8) -> Challenge {
    Challenge {
        salt: "sal".into(),
        seed: "semilla".into(),
        bits,
        expires: 1_000,
    }
}

#[test]
fn answers_a_challenge_with_a_proof_the_server_takes() {
    let asked = challenge(8);
    let said = solved(&serde_json::to_string(&asked).unwrap()).unwrap();
    let proof: Proof = serde_json::from_str(&said).unwrap();
    assert_eq!(proof.challenge, asked);
    assert!(meets(&asked, proof.nonce));
}

#[test]
fn answers_nothing_to_what_is_no_challenge_or_one_nobody_could_finish() {
    assert_eq!(solved("{"), None);
    assert_eq!(
        solved(&serde_json::to_string(&challenge(40)).unwrap()),
        None
    );
}

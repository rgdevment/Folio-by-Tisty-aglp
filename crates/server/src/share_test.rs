use std::cell::{Cell, RefCell};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use jiff::Timestamp;
use tisty_share_proto::envelope::{self, Draft, Kind, LinkKey, Signer};
use tisty_share_proto::identity::{Root, ShareKey};
use tisty_share_proto::work;

use super::*;
use crate::memory::Memory;
use crate::moderation::{Category, Complaint, DETAIL_AT_MOST};
use crate::store::Doc;
use crate::testing::{Counting, done};

struct Empty;

impl Randomness for Empty {
    fn fill(&mut self, _: &mut [u8]) -> bool {
        false
    }
}

const DAY: i64 = 24 * 60 * 60;
const HOUR: i64 = 60 * 60;
const T0: i64 = 1_800_000_000;
const HERE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));

fn there(n: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(198, 51, 100, n))
}

/// Little work, so the tests run quickly; one test asks for the server's own.
fn policy() -> Policy {
    Policy {
        slowness: Slowness { log_n: 4, r: 8 },
        work: Work {
            reserve: 4,
            upload: 4,
            per_megabyte: 1,
            report: 4,
            lasts: 10 * 60,
        },
        ..Policy::default()
    }
}

fn key() -> LinkKey {
    LinkKey::from_bytes(&[9; 32])
}

fn sealed(id: &str, version: u64, from: Option<u64>, text: &str) -> Vec<u8> {
    let draft = Draft {
        id,
        version,
        from,
        text,
        pictures: &[],
    };
    envelope::seal(&key(), &draft, None, &Limits::default())
        .unwrap()
        .to_bytes()
}

fn opened(served: &Served) -> String {
    let arrived = Envelope::read(served.envelope.clone(), &Limits::default()).unwrap();
    envelope::open(&key(), &arrived, &[])
        .unwrap()
        .text
        .to_string()
}

fn digest_of(bytes: &[u8]) -> [u8; 32] {
    Envelope::read(bytes.to_vec(), &Limits::default())
        .unwrap()
        .digest()
}

/// The server as a Tisty and a browser meet it: every step pays the work it is asked.
struct World {
    share: Share<Memory, Counting>,
}

impl World {
    fn new() -> Self {
        Self::with(policy())
    }

    fn with(policy: Policy) -> Self {
        Self {
            share: Share::new(Memory::default(), Counting(0), policy, [5; 32]),
        }
    }

    fn proof(&mut self, ask: Ask, now: i64) -> Proof {
        work::solve(&self.share.challenge(ask, now).unwrap()).unwrap()
    }

    fn reserve_from(&mut self, caller: IpAddr, now: i64) -> Result<Reserved, Refused> {
        let proof = self.proof(Ask::Reserve, now);
        done(self.share.reserve(caller, &proof, now))
    }

    fn reserve(&mut self, now: i64) -> Reserved {
        self.reserve_from(HERE, now).unwrap()
    }

    fn put(&mut self, id: &str, edit: &str, bytes: Vec<u8>, now: i64) -> Result<u64, Refused> {
        let ask = Ask::Upload {
            id,
            digest: digest_of(&bytes),
            bytes: bytes.len() as u64,
        };
        let proof = self.proof(ask, now);
        done(self.share.upload(id, edit, bytes, HERE, &proof, now))
    }

    /// A document already shared once.
    fn shared(&mut self, now: i64) -> Reserved {
        let reserved = self.reserve(now);
        let first = sealed(&reserved.id, 1, None, "uno");
        assert_eq!(self.put(&reserved.id, &reserved.edit, first, now), Ok(1));
        reserved
    }

    fn read(&mut self, id: &str, now: i64) -> Result<Served, Refused> {
        self.read_from(id, None, HERE, now)
    }

    fn read_from(
        &mut self,
        id: &str,
        password: Option<&str>,
        caller: IpAddr,
        now: i64,
    ) -> Result<Served, Refused> {
        done(self.share.read(id, password, caller, now))
    }

    fn manage(&mut self, reserved: &Reserved, what: Manage, now: i64) -> Result<(), Refused> {
        done(self.share.manage(&reserved.id, &reserved.admin, what, now))
    }

    fn report_from(&mut self, id: &str, caller: IpAddr, now: i64) -> Result<(), Refused> {
        let proof = self.proof(Ask::Report { id }, now);
        let complaint = Complaint {
            category: Category::Phishing,
            detail: "pide la clave del banco".into(),
            link: None,
        };
        done(self.share.report(id, complaint, caller, &proof, now))
    }

    fn doc(&self, id: &str) -> Doc {
        done(self.share.store.doc(id)).unwrap().unwrap()
    }
}

#[test]
fn a_document_is_reserved_shared_and_read_as_tisty_sealed_it() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    assert_eq!(reserved.id.len(), 8);

    let served = world.read(&reserved.id, T0 + 10).unwrap();
    assert_eq!(served.version, 1);
    assert_eq!(opened(&served), "uno");
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0)),
        Ok(Some(1))
    );
}

#[test]
fn only_the_edit_link_uploads() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    let next = sealed(&reserved.id, 2, Some(1), "dos");

    for wrong in [reserved.admin.as_str(), "anything", ""] {
        assert_eq!(
            world.put(&reserved.id, wrong, next.clone(), T0),
            Err(Refused::Forbidden)
        );
    }
    assert_eq!(world.put(&reserved.id, &reserved.edit, next, T0), Ok(2));
}

#[test]
fn an_envelope_sealed_for_another_document_is_refused() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    let elsewhere = sealed("someOther", 2, Some(1), "dos");

    assert_eq!(
        world.put(&reserved.id, &reserved.edit, elsewhere, T0),
        Err(Refused::Misaddressed)
    );
}

#[test]
fn a_change_written_on_an_older_version_is_sent_back_to_be_chosen() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    let mine = sealed(&reserved.id, 2, Some(1), "mía");
    let theirs = sealed(&reserved.id, 2, Some(1), "suya");

    assert_eq!(world.put(&reserved.id, &reserved.edit, mine, T0), Ok(2));
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, theirs, T0),
        Err(Refused::Behind { latest: Some(2) })
    );
    let skipping = sealed(&reserved.id, 4, Some(2), "salta");
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, skipping, T0),
        Err(Refused::Behind { latest: Some(2) })
    );
    assert_eq!(opened(&world.read(&reserved.id, T0).unwrap()), "mía");
}

#[test]
fn readers_get_only_the_latest_and_the_editors_see_the_last_five() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    for version in 2..=7 {
        let next = sealed(
            &reserved.id,
            version,
            Some(version - 1),
            &format!("v{version}"),
        );
        world.put(&reserved.id, &reserved.edit, next, T0).unwrap();
    }

    let served = world.read(&reserved.id, T0).unwrap();
    assert_eq!((served.version, opened(&served)), (7, "v7".to_owned()));
    assert_eq!(world.share.store.envelopes(), 5);
    let third = done(world.share.version(&reserved.id, &reserved.admin, 3, T0)).unwrap();
    assert_eq!(opened(&third), "v3");
    assert_eq!(
        done(world.share.version(&reserved.id, &reserved.edit, 2, T0)),
        Err(Refused::Missing)
    );
    assert_eq!(
        done(world.share.version(&reserved.id, "a reader", 3, T0)),
        Err(Refused::Forbidden)
    );
}

#[test]
fn an_envelope_over_the_server_s_limits_is_refused() {
    let mut world = World::new();
    world.share.policy.limits.text = 3;
    let reserved = world.reserve(T0);
    let long = sealed(&reserved.id, 1, None, "demasiado");

    // Sealed under Tisty's own limits, read under the server's tighter ones.
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, long, T0),
        Err(Refused::Envelope(Unread::TextTooBig))
    );
}

#[test]
fn a_signed_envelope_is_taken_with_its_signature() {
    let mut world = World::new();
    let reserved = world.reserve(T0);
    let root = Root::from_bytes(&[1; 32]);
    let machine = ShareKey::from_bytes(&[2; 32]);
    let certificate = root.certify(&machine.public(), Timestamp::from_second(1_000).unwrap());
    let signer = Signer {
        key: &machine,
        certificate: &certificate,
    };
    let draft = Draft {
        id: &reserved.id,
        version: 1,
        from: None,
        text: "firmado",
        pictures: &[(Kind::Png, b"\x89PNG\r\n\x1a\n...")],
    };
    let bytes = envelope::seal(&key(), &draft, Some(&signer), &Limits::default())
        .unwrap()
        .to_bytes();

    assert_eq!(world.put(&reserved.id, &reserved.edit, bytes, T0), Ok(1));
}

#[test]
fn a_password_is_asked_for_counted_and_after_five_misses_waits() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world
        .manage(&reserved, Manage::Password(Some("perro azul".into())), T0)
        .unwrap();

    assert_eq!(world.read(&reserved.id, T0), Err(Refused::PasswordAsked));
    for _ in 0..5 {
        assert_eq!(
            world.read_from(&reserved.id, Some("gato"), HERE, T0),
            Err(Refused::PasswordWrong)
        );
    }
    // Even the right one waits until the lock lifts.
    let locked = world.share.policy.locked;
    assert_eq!(
        world.read_from(&reserved.id, Some("perro azul"), HERE, T0 + 60),
        Err(Refused::PasswordLocked { until: T0 + locked })
    );
    let later = T0 + locked + 1;
    assert!(
        world
            .read_from(&reserved.id, Some("perro azul"), HERE, later)
            .is_ok()
    );

    world
        .manage(&reserved, Manage::Password(None), later)
        .unwrap();
    assert!(world.read(&reserved.id, later).is_ok());
}

#[test]
fn a_document_nobody_reads_for_thirty_days_is_gone() {
    let mut world = World::new();
    let reserved = world.shared(T0);

    assert!(world.read(&reserved.id, T0 + 29 * DAY).is_ok());
    // That read moved the end to day 59.
    assert!(world.read(&reserved.id, T0 + 58 * DAY).is_ok());
    assert_eq!(world.read(&reserved.id, T0 + 89 * DAY), Err(Refused::Gone));
    assert_eq!(
        world.read(&reserved.id, T0 + 89 * DAY),
        Err(Refused::Missing)
    );
    assert_eq!(world.share.store.envelopes(), 0);
}

#[test]
fn tisty_asking_for_the_latest_version_is_not_activity() {
    let mut world = World::new();
    let reserved = world.shared(T0);

    for day in [10, 20, 29] {
        assert_eq!(
            done(world.share.latest(&reserved.id, HERE, T0 + day * DAY)),
            Ok(Some(1))
        );
    }
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0 + 31 * DAY)),
        Err(Refused::Gone)
    );
}

#[test]
fn the_owner_s_visit_and_a_new_version_count_as_activity() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world
        .manage(&reserved, Manage::Visit, T0 + 25 * DAY)
        .unwrap();
    let next = sealed(&reserved.id, 2, Some(1), "dos");
    world
        .put(&reserved.id, &reserved.edit, next, T0 + 50 * DAY)
        .unwrap();

    assert!(world.read(&reserved.id, T0 + 79 * DAY).is_ok());
}

#[test]
fn reads_behind_a_password_write_only_what_changed() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world
        .manage(&reserved, Manage::Password(Some("perro azul".into())), T0)
        .unwrap();
    world
        .read_from(&reserved.id, Some("perro azul"), HERE, T0)
        .unwrap();
    let before = world.doc(&reserved.id).revision;
    for minute in 1..=5 {
        world
            .read_from(&reserved.id, Some("perro azul"), HERE, T0 + minute * 60)
            .unwrap();
    }
    assert_eq!(world.doc(&reserved.id).revision, before);

    // A right password after a miss clears it, so that one is written.
    assert_eq!(
        world.read_from(&reserved.id, Some("gato"), HERE, T0 + 600),
        Err(Refused::PasswordWrong)
    );
    world
        .read_from(&reserved.id, Some("perro azul"), HERE, T0 + 660)
        .unwrap();
    let gate = world.doc(&reserved.id).gate.unwrap();
    assert_eq!(gate.missed, 0);
}

#[test]
fn reads_close_together_write_the_activity_down_once() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.read(&reserved.id, T0).unwrap();
    let before = world.doc(&reserved.id).revision;
    for minute in 1..=30 {
        world.read(&reserved.id, T0 + minute * 60).unwrap();
    }

    assert_eq!(world.doc(&reserved.id).revision, before);
    world.read(&reserved.id, T0 + 2 * HOUR).unwrap();
    assert_eq!(world.doc(&reserved.id).revision, before + 1);
}

#[test]
fn an_owner_may_ask_for_a_shorter_life_never_a_longer_one() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.manage(&reserved, Manage::Idle(7 * DAY), T0).unwrap();
    assert_eq!(world.read(&reserved.id, T0 + 8 * DAY), Err(Refused::Gone));

    let reserved = world.shared(T0);
    world
        .manage(&reserved, Manage::Idle(365 * DAY), T0)
        .unwrap();
    assert_eq!(world.read(&reserved.id, T0 + 31 * DAY), Err(Refused::Gone));
}

#[test]
fn a_paused_document_is_not_served_and_its_trash_time_runs_instead() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.manage(&reserved, Manage::Pause, T0 + DAY).unwrap();

    assert_eq!(world.read(&reserved.id, T0 + DAY), Err(Refused::Paused));
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0 + DAY)),
        Err(Refused::Paused)
    );
    let next = sealed(&reserved.id, 2, Some(1), "dos");
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, next, T0 + DAY),
        Err(Refused::Paused)
    );
    world
        .manage(&reserved, Manage::Restore, T0 + 20 * DAY)
        .unwrap();
    assert!(world.read(&reserved.id, T0 + 45 * DAY).is_ok());

    world
        .manage(&reserved, Manage::Pause, T0 + 46 * DAY)
        .unwrap();
    assert_eq!(world.read(&reserved.id, T0 + 77 * DAY), Err(Refused::Gone));
}

#[test]
fn deleting_takes_the_document_and_every_envelope_away() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    assert_eq!(
        done(
            world
                .share
                .manage(&reserved.id, &reserved.edit, Manage::Delete, T0)
        ),
        Err(Refused::Forbidden)
    );
    world.manage(&reserved, Manage::Delete, T0).unwrap();

    assert_eq!(world.read(&reserved.id, T0), Err(Refused::Missing));
    assert_eq!(world.share.store.envelopes(), 0);
}

#[test]
fn a_sweep_takes_only_so_many_and_the_next_takes_the_rest() {
    let mut world = World::with(Policy {
        sweep: 2,
        ..policy()
    });
    for _ in 0..3 {
        world.shared(T0);
    }
    let later = T0 + 31 * DAY;
    let gone = |world: &World| done(world.share.sweep(later)).unwrap().gone;
    assert_eq!(gone(&world), 2);
    assert_eq!(gone(&world), 1);
    assert_eq!(gone(&world), 0);
}

#[test]
fn a_gate_keeps_how_slow_it_was_made_and_opens_after_the_server_grows_slower() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world
        .manage(&reserved, Manage::Password(Some("perro azul".into())), T0)
        .unwrap();
    world.share.policy.slowness = Slowness { log_n: 5, r: 8 };

    assert!(
        world
            .read_from(&reserved.id, Some("perro azul"), HERE, T0)
            .is_ok()
    );
}

#[test]
fn a_sweep_takes_whatever_ran_out_and_leaves_the_rest() {
    let mut world = World::new();
    let old = world.shared(T0);
    let never_used = world.reserve(T0);
    let fresh = world.reserve(T0 + 20 * DAY);
    let first = sealed(&fresh.id, 1, None, "nuevo");
    world
        .put(&fresh.id, &fresh.edit, first, T0 + 20 * DAY)
        .unwrap();
    let kept_before = world.share.store.kept();

    assert_eq!(done(world.share.sweep(T0 + 31 * DAY)).unwrap().gone, 2);
    assert!(world.share.store.kept() < kept_before);
    assert_eq!(world.read(&old.id, T0 + 31 * DAY), Err(Refused::Missing));
    assert_eq!(
        world.read(&never_used.id, T0 + 31 * DAY),
        Err(Refused::Missing)
    );
    assert!(world.read(&fresh.id, T0 + 31 * DAY).is_ok());
}

#[test]
fn a_reserved_id_with_nothing_uploaded_cannot_be_read_yet() {
    let mut world = World::new();
    let reserved = world.reserve(T0);
    assert_eq!(world.read(&reserved.id, T0), Err(Refused::Unwritten));
    assert_eq!(done(world.share.latest(&reserved.id, HERE, T0)), Ok(None));
}

#[test]
fn nothing_is_reserved_without_randomness() {
    let mut share = Share::new(Memory::default(), Empty, policy(), [5; 32]);
    assert_eq!(
        share.challenge(Ask::Reserve, T0).err(),
        Some(Refused::NoRandomness)
    );
}

#[test]
fn every_step_pays_its_work_and_a_proof_answers_only_once() {
    let mut world = World::new();
    let proof = world.proof(Ask::Reserve, T0);
    assert!(done(world.share.reserve(HERE, &proof, T0)).is_ok());
    assert_eq!(
        done(world.share.reserve(HERE, &proof, T0)).err(),
        Some(Refused::WorkRefused)
    );

    let mut wrong = world.proof(Ask::Reserve, T0);
    wrong.nonce += 1;
    while work::meets(&wrong.challenge, wrong.nonce) {
        wrong.nonce += 1;
    }
    assert_eq!(
        done(world.share.reserve(HERE, &wrong, T0)).err(),
        Some(Refused::WorkRefused)
    );

    let expired = world.proof(Ask::Reserve, T0);
    assert_eq!(
        done(world.share.reserve(HERE, &expired, T0 + HOUR)).err(),
        Some(Refused::WorkRefused)
    );

    let mut other_server = Share::new(Memory::default(), Counting(0), policy(), [6; 32]);
    let theirs = work::solve(&other_server.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    assert_eq!(
        done(world.share.reserve(HERE, &theirs, T0)).err(),
        Some(Refused::WorkRefused)
    );
}

#[test]
fn work_done_for_one_envelope_does_not_carry_another() {
    let mut world = World::new();
    let reserved = world.reserve(T0);
    let meant = sealed(&reserved.id, 1, None, "este");
    let other = sealed(&reserved.id, 1, None, "otro");
    let ask = Ask::Upload {
        id: &reserved.id,
        digest: digest_of(&meant),
        bytes: meant.len() as u64,
    };
    let proof = world.proof(ask, T0);

    assert_eq!(
        done(
            world
                .share
                .upload(&reserved.id, &reserved.edit, other, HERE, &proof, T0)
        ),
        Err(Refused::WorkRefused)
    );
    assert_eq!(
        done(
            world
                .share
                .upload(&reserved.id, &reserved.edit, meant, HERE, &proof, T0)
        ),
        Ok(1)
    );
}

#[test]
fn a_heavier_envelope_costs_more_work_than_it_was_asked_for_when_it_claims_to_be_light() {
    let mut world = World::with(Policy {
        work: Work {
            upload: 1,
            per_megabyte: 6,
            ..policy().work
        },
        ..policy()
    });
    let reserved = world.reserve(T0);
    // Four pictures near the limit make it weigh close to 2 MB.
    let mut picture = b"\x89PNG\r\n\x1a\n".to_vec();
    picture.resize(500 * 1024, 7);
    let pictures: Vec<(Kind, &[u8])> = (0..4).map(|_| (Kind::Png, picture.as_slice())).collect();
    let draft = Draft {
        id: &reserved.id,
        version: 1,
        from: None,
        text: "pesado",
        pictures: &pictures,
    };
    let heavy = envelope::seal(&key(), &draft, None, &Limits::default())
        .unwrap()
        .to_bytes();
    assert!(heavy.len() > 1024 * 1024);
    let ask = Ask::Upload {
        id: &reserved.id,
        digest: digest_of(&heavy),
        bytes: 10,
    };
    let light_work = world.proof(ask, T0);

    assert_eq!(
        done(
            world
                .share
                .upload(&reserved.id, &reserved.edit, heavy, HERE, &light_work, T0)
        ),
        Err(Refused::WorkRefused)
    );
}

#[test]
fn the_server_s_own_work_is_solved_in_a_moment() {
    let mut world = World::with(Policy::default());
    let challenge = world.share.challenge(Ask::Reserve, T0).unwrap();
    assert_eq!(challenge.bits, Work::default().reserve);
    assert!(work::solve(&challenge).is_some());
}

#[test]
fn too_many_reads_in_an_hour_wait_out_the_hour_and_never_longer() {
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            reads: 3,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    let reserved = world.shared(T0);
    for _ in 0..3 {
        world.read(&reserved.id, T0).unwrap();
    }
    assert_eq!(
        world.read(&reserved.id, T0),
        Err(Refused::Slow { until: T0 + HOUR })
    );
    assert_eq!(
        world.read(&reserved.id, T0 + HOUR / 2),
        Err(Refused::Slow { until: T0 + HOUR })
    );
    // Someone else is not held back by it.
    assert!(world.read_from(&reserved.id, None, there(7), T0).is_ok());

    // A network of many readers goes past it again and still waits only the hour.
    let next_hour = T0 + HOUR + 1;
    for _ in 0..3 {
        world.read(&reserved.id, next_hour).unwrap();
    }
    assert_eq!(
        world.read(&reserved.id, next_hour),
        Err(Refused::Slow {
            until: T0 + 2 * HOUR
        })
    );
}

#[test]
fn too_many_reservations_in_an_hour_wait_an_hour_and_then_a_day() {
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            reserves: 1,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    world.reserve(T0);
    assert_eq!(
        world.reserve_from(HERE, T0).err(),
        Some(Refused::Slow { until: T0 + HOUR })
    );
    let next_hour = T0 + HOUR + 1;
    world.reserve(next_hour);
    assert_eq!(
        world.reserve_from(HERE, next_hour).err(),
        Some(Refused::Slow {
            until: next_hour + DAY
        })
    );
}

#[test]
fn tisty_asking_for_changes_has_its_own_allowance_and_waits_only_the_hour() {
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            reads: 1,
            polls: 2,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    let reserved = world.shared(T0);
    world.read(&reserved.id, T0).unwrap();
    for _ in 0..2 {
        assert_eq!(
            done(world.share.latest(&reserved.id, HERE, T0)),
            Ok(Some(1))
        );
    }
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0)),
        Err(Refused::Slow { until: T0 + HOUR })
    );
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0 + HOUR)),
        Ok(Some(1))
    );
}

#[test]
fn a_day_s_documents_and_bytes_are_counted_per_caller() {
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            documents_a_day: 2,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    let tomorrow = (T0.div_euclid(DAY) + 1) * DAY;
    world.reserve(T0);
    world.reserve(T0);
    // A spent day waits for the next one, however often it is asked.
    for _ in 0..3 {
        assert_eq!(
            world.reserve_from(HERE, T0).err(),
            Some(Refused::Slow { until: tomorrow })
        );
    }
    assert!(world.reserve_from(there(9), T0).is_ok());
    assert!(world.reserve_from(HERE, tomorrow).is_ok());
}

#[test]
fn an_upload_that_is_refused_spends_none_of_the_day_s_bytes() {
    let size = sealed("someOneId", 1, None, "uno").len() as u64;
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            bytes_a_day: size,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    let reserved = world.reserve(T0);
    let elsewhere = sealed("someOther", 1, None, "uno");
    assert_eq!(elsewhere.len() as u64, size);
    for _ in 0..3 {
        assert_eq!(
            world.put(&reserved.id, &reserved.edit, elsewhere.clone(), T0),
            Err(Refused::Misaddressed)
        );
    }

    let first = sealed(&reserved.id, 1, None, "uno");
    assert_eq!(world.put(&reserved.id, &reserved.edit, first, T0), Ok(1));
    let next = sealed(&reserved.id, 2, Some(1), "dos");
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, next, T0),
        Err(Refused::Slow {
            until: (T0.div_euclid(DAY) + 1) * DAY
        })
    );
}

#[test]
fn addresses_of_one_ipv6_network_share_its_allowance() {
    let mut world = World::with(Policy {
        allowance: guard::Allowance {
            reads: 1,
            ..guard::Allowance::default()
        },
        ..policy()
    });
    let reserved = world.shared(T0);
    let one = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 0, 0, 0, 1));
    let same_net = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 9, 9, 9, 9));
    let next_net = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 3, 0, 0, 0, 1));

    assert!(world.read_from(&reserved.id, None, one, T0).is_ok());
    assert!(matches!(
        world.read_from(&reserved.id, None, same_net, T0),
        Err(Refused::Slow { .. })
    ));
    assert!(world.read_from(&reserved.id, None, next_net, T0).is_ok());
}

#[test]
fn a_reader_is_counted_once_a_day_and_the_owner_sees_the_count() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    for _ in 0..3 {
        world.read(&reserved.id, T0).unwrap();
    }
    world.read_from(&reserved.id, None, there(1), T0).unwrap();
    world.read(&reserved.id, T0 + DAY).unwrap();

    let info = done(world.share.info(&reserved.id, &reserved.admin, T0 + DAY)).unwrap();
    assert_eq!(info.reads, 3);
    assert_eq!(info.latest, Some(1));
    assert!(!info.blocked && !info.paused && !info.gated);
    assert_eq!(
        done(world.share.info(&reserved.id, &reserved.edit, T0)).err(),
        Some(Refused::Forbidden)
    );
}

#[test]
fn reports_from_three_places_block_the_document_and_keep_it_as_evidence() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.report_from(&reserved.id, there(1), T0).unwrap();
    world.report_from(&reserved.id, there(2), T0).unwrap();
    assert!(world.read(&reserved.id, T0).is_ok());
    world.report_from(&reserved.id, there(3), T0).unwrap();

    assert_eq!(world.read(&reserved.id, T0), Err(Refused::Blocked));
    assert_eq!(
        done(world.share.latest(&reserved.id, HERE, T0)),
        Err(Refused::Blocked)
    );
    assert_eq!(
        world.manage(&reserved, Manage::Delete, T0),
        Err(Refused::Blocked)
    );
    let next = sealed(&reserved.id, 2, Some(1), "otra cosa");
    assert_eq!(
        world.put(&reserved.id, &reserved.edit, next, T0),
        Err(Refused::Blocked)
    );
    // Its idle days would have ended it at day 30; the evidence keeps it to day 90.
    assert_eq!(
        world.read(&reserved.id, T0 + 60 * DAY),
        Err(Refused::Blocked)
    );
    assert_eq!(world.read(&reserved.id, T0 + 91 * DAY), Err(Refused::Gone));
}

#[test]
fn one_place_reports_a_document_once() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.report_from(&reserved.id, there(1), T0).unwrap();

    assert_eq!(
        world.report_from(&reserved.id, there(1), T0 + DAY),
        Err(Refused::Reported)
    );
}

#[test]
fn a_report_says_what_is_against_the_law_in_a_few_words() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    let proof = world.proof(Ask::Report { id: &reserved.id }, T0);
    let long = Complaint {
        category: Category::Fraud,
        detail: "x".repeat(DETAIL_AT_MOST + 1),
        link: None,
    };
    assert_eq!(
        done(world.share.report(&reserved.id, long, there(1), &proof, T0)),
        Err(Refused::TooLong)
    );
    let posing = Complaint {
        category: Category::Appeal,
        detail: String::new(),
        link: None,
    };
    assert_eq!(
        done(
            world
                .share
                .report(&reserved.id, posing, there(1), &proof, T0)
        ),
        Err(Refused::Forbidden)
    );
}

#[test]
fn the_owner_appeals_a_block_from_the_management_link_only() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    assert_eq!(
        done(
            world
                .share
                .appeal(&reserved.id, &reserved.admin, "era una broma", T0)
        ),
        Err(Refused::Missing)
    );
    for place in 1..=3 {
        world.report_from(&reserved.id, there(place), T0).unwrap();
    }

    assert_eq!(
        done(world.share.appeal(&reserved.id, &reserved.edit, "mío", T0)),
        Err(Refused::Forbidden)
    );
    assert!(
        done(
            world
                .share
                .appeal(&reserved.id, &reserved.admin, "es mío y es legal", T0)
        )
        .is_ok()
    );
    assert_eq!(
        done(
            world
                .share
                .appeal(&reserved.id, &reserved.admin, "otra vez", T0 + DAY)
        ),
        Err(Refused::Reported)
    );
    let filed = done(world.share.store.reports(&reserved.id, T0)).unwrap();
    assert_eq!(filed.len(), 4);
    assert_eq!(filed.last().unwrap().category, Category::Appeal);
    assert!(
        done(world.share.info(&reserved.id, &reserved.admin, T0))
            .unwrap()
            .blocked
    );
}

/// A store that fails on purpose, one way per field, over the store in memory.
struct Faulty {
    inner: Memory,
    /// Loses the next save once, as if another writer had saved between reading and writing.
    lose: Cell<bool>,
    /// Turns reads away until then, as a host's own limiter would.
    limited: Cell<Option<i64>>,
    /// A document whose envelopes the store cannot let go of.
    stuck: RefCell<Option<String>>,
    /// Counters, marks and reports past their time that cannot be let go of.
    unlapsing: Cell<bool>,
}

impl Store for Faulty {
    async fn doc(&self, id: &str) -> Result<Option<Doc>, Fault> {
        self.inner.doc(id).await
    }
    async fn save(&self, doc: &Doc, revision: Option<u64>) -> Result<Saved, Fault> {
        if self.lose.replace(false) {
            return Ok(Saved::Raced);
        }
        self.inner.save(doc, revision).await
    }
    async fn forget(&self, id: &str) -> Result<(), Fault> {
        if self.stuck.borrow().as_deref() == Some(id) {
            return Err(Fault("the envelopes would not go".into()));
        }
        self.inner.forget(id).await
    }
    async fn envelope(&self, id: &str, kept: &Kept) -> Result<Option<Vec<u8>>, Fault> {
        self.inner.envelope(id, kept).await
    }
    async fn keep(&self, id: &str, kept: &Kept, bytes: Vec<u8>) -> Result<(), Fault> {
        self.inner.keep(id, kept, bytes).await
    }
    async fn drop_envelope(&self, id: &str, kept: &Kept) -> Result<(), Fault> {
        self.inner.drop_envelope(id, kept).await
    }
    async fn ending(&self, now: i64, at_most: usize) -> Result<Vec<String>, Fault> {
        self.inner.ending(now, at_most).await
    }
    async fn count(&self, key: &str, by: u64, until: i64, now: i64) -> Result<u64, Fault> {
        self.inner.count(key, by, until, now).await
    }
    async fn hold(&self, key: &str, until: i64) -> Result<(), Fault> {
        self.inner.hold(key, until).await
    }
    async fn held(&self, key: &str, now: i64) -> Result<Option<i64>, Fault> {
        self.inner.held(key, now).await
    }
    async fn mark(&self, key: &str, until: i64, now: i64) -> Result<bool, Fault> {
        self.inner.mark(key, until, now).await
    }
    async fn within(
        &self,
        act: guard::Act,
        who: &str,
        allowance: u64,
        now: i64,
    ) -> Result<Option<i64>, Fault> {
        match (act, self.limited.get()) {
            (guard::Act::Read, Some(until)) => Ok(Some(until)),
            _ => self.inner.within(act, who, allowance, now).await,
        }
    }
    async fn file(&self, report: &crate::moderation::Report) -> Result<(), Fault> {
        self.inner.file(report).await
    }
    async fn reports(&self, id: &str, now: i64) -> Result<Vec<crate::moderation::Report>, Fault> {
        self.inner.reports(id, now).await
    }
    async fn lapse(&self, now: i64) -> Result<(), Fault> {
        if self.unlapsing.get() {
            return Err(Fault("the old counters would not go".into()));
        }
        self.inner.lapse(now).await
    }
}

fn faulty() -> Share<Faulty, Counting> {
    let store = Faulty {
        inner: Memory::default(),
        lose: Cell::new(false),
        limited: Cell::new(None),
        stuck: RefCell::new(None),
        unlapsing: Cell::new(false),
    };
    Share::new(store, Counting(0), policy(), [5; 32])
}

fn upload_faulty(
    share: &mut Share<Faulty, Counting>,
    reserved: &Reserved,
    bytes: Vec<u8>,
) -> Result<u64, Refused> {
    let ask = Ask::Upload {
        id: &reserved.id,
        digest: digest_of(&bytes),
        bytes: bytes.len() as u64,
    };
    let proof = work::solve(&share.challenge(ask, T0).unwrap()).unwrap();
    done(share.upload(&reserved.id, &reserved.edit, bytes, HERE, &proof, T0))
}

#[test]
fn an_upload_that_loses_the_race_leaves_nothing_of_itself_behind() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    share.store.lose.set(true);
    let first = sealed(&reserved.id, 1, None, "perdió");

    assert_eq!(
        upload_faulty(&mut share, &reserved, first),
        Err(Refused::Behind { latest: None })
    );
    assert_eq!(share.store.inner.envelopes(), 0);
}

#[test]
fn an_upload_that_keeps_nothing_spends_none_of_the_day() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    let first = sealed(&reserved.id, 1, None, "uno");
    share.policy.allowance.bytes_a_day = first.len() as u64;
    share.store.lose.set(true);

    assert_eq!(
        upload_faulty(&mut share, &reserved, first.clone()),
        Err(Refused::Behind { latest: None })
    );
    assert_eq!(upload_faulty(&mut share, &reserved, first), Ok(1));
}

#[test]
fn the_report_that_blocks_holds_its_block_even_when_it_loses_a_race() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    let first = sealed(&reserved.id, 1, None, "uno");
    upload_faulty(&mut share, &reserved, first).unwrap();
    for place in 1..=3 {
        if place == 3 {
            share.store.lose.set(true);
        }
        let ask = Ask::Report { id: &reserved.id };
        let proof = work::solve(&share.challenge(ask, T0).unwrap()).unwrap();
        let complaint = Complaint {
            category: Category::Phishing,
            detail: "pide la clave del banco".into(),
            link: None,
        };
        assert_eq!(
            done(share.report(&reserved.id, complaint, there(place), &proof, T0)),
            Ok(())
        );
    }

    let doc = done(share.store.doc(&reserved.id)).unwrap().unwrap();
    assert_eq!(doc.blocked, Some(T0));
}

#[test]
fn a_wrong_password_that_loses_a_race_is_still_wrong_and_still_counted() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    let first = sealed(&reserved.id, 1, None, "uno");
    upload_faulty(&mut share, &reserved, first).unwrap();
    let password = Manage::Password(Some("perro azul".into()));
    done(share.manage(&reserved.id, &reserved.admin, password, T0)).unwrap();
    share.store.lose.set(true);

    assert_eq!(
        done(share.read(&reserved.id, Some("gato"), HERE, T0)),
        Err(Refused::PasswordWrong)
    );
    let doc = done(share.store.doc(&reserved.id)).unwrap().unwrap();
    assert_eq!(doc.gate.unwrap().missed, 1);
}

#[test]
fn a_host_s_own_limiter_decides_the_reads_and_its_wait_is_the_one_told() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    let first = sealed(&reserved.id, 1, None, "uno");
    upload_faulty(&mut share, &reserved, first).unwrap();
    share.store.limited.set(Some(T0 + 60));

    for _ in 0..3 {
        assert_eq!(
            done(share.read(&reserved.id, None, HERE, T0)),
            Err(Refused::Slow { until: T0 + 60 })
        );
    }
    share.store.limited.set(None);
    assert!(done(share.read(&reserved.id, None, HERE, T0 + 60)).is_ok());
}

#[test]
fn a_document_that_cannot_go_is_passed_over_and_the_rest_still_go() {
    let mut share = faulty();
    let mut ids = Vec::new();
    for _ in 0..3 {
        let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
        let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
        let first = sealed(&reserved.id, 1, None, "uno");
        upload_faulty(&mut share, &reserved, first).unwrap();
        ids.push(reserved.id);
    }
    ids.sort();
    *share.store.stuck.borrow_mut() = Some(ids[0].clone());

    let later = T0 + 31 * DAY;
    let swept = done(share.sweep(later)).unwrap();
    assert_eq!(swept.gone, 2);
    assert_eq!(swept.stuck.len(), 1);
    assert_eq!(swept.stuck[0].0, ids[0]);
    assert_eq!(swept.stuck[0].1, Fault("the envelopes would not go".into()));

    // It waits a day before it is tried again, and reading it says only that it is gone.
    let again = done(share.sweep(later + 60)).unwrap();
    assert_eq!((again.gone, again.stuck.len()), (0, 0));
    assert_eq!(
        done(share.read(&ids[0], None, HERE, later + 60)),
        Err(Refused::Gone)
    );
    *share.store.stuck.borrow_mut() = None;
    assert_eq!(done(share.sweep(later + DAY + 1)).unwrap().gone, 1);
}

#[test]
fn old_counters_that_cannot_go_never_keep_documents_from_going() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    upload_faulty(&mut share, &reserved, sealed(&reserved.id, 1, None, "uno")).unwrap();
    share.store.unlapsing.set(true);

    let swept = done(share.sweep(T0 + 31 * DAY)).unwrap();
    assert_eq!(swept.gone, 1);
    assert_eq!(
        swept.unlapsed,
        Some(Fault("the old counters would not go".into()))
    );
}

#[test]
fn a_stored_document_missing_a_later_field_still_opens_and_one_missing_its_end_does_not() {
    let doc = Doc {
        id: "abc".into(),
        edit: [1; 32],
        admin: [2; 32],
        gate: None,
        versions: Vec::new(),
        created: T0,
        active: T0,
        idle: DAY,
        ends: T0 + DAY,
        paused: None,
        blocked: None,
        reads: 0,
        revision: 0,
    };
    let written: serde_json::Value = serde_json::to_value(&doc).unwrap();
    let without = |field: &str| {
        let mut row = written.clone();
        row.as_object_mut().unwrap().remove(field);
        serde_json::from_value::<Doc>(row)
    };
    assert_eq!(without("reads").unwrap(), doc);
    assert_eq!(without("paused").unwrap(), doc);
    assert!(without("ends").is_err());
    assert!(without("admin").is_err());
}

#[test]
fn neither_link_reaches_an_earlier_version_of_a_blocked_or_paused_document() {
    let mut world = World::new();
    let reserved = world.shared(T0);
    world.manage(&reserved, Manage::Pause, T0).unwrap();
    assert_eq!(
        done(world.share.version(&reserved.id, &reserved.edit, 1, T0)),
        Err(Refused::Paused)
    );
    world.manage(&reserved, Manage::Restore, T0).unwrap();
    for place in 1..=3 {
        world.report_from(&reserved.id, there(place), T0).unwrap();
    }
    assert_eq!(
        done(world.share.version(&reserved.id, &reserved.admin, 1, T0)),
        Err(Refused::Blocked)
    );
}

#[test]
fn two_readers_racing_to_write_their_visit_are_both_served() {
    let mut share = faulty();
    let proof = work::solve(&share.challenge(Ask::Reserve, T0).unwrap()).unwrap();
    let reserved = done(share.reserve(HERE, &proof, T0)).unwrap();
    let first = sealed(&reserved.id, 1, None, "uno");
    upload_faulty(&mut share, &reserved, first).unwrap();
    share.store.lose.set(true);

    assert!(done(share.read(&reserved.id, None, HERE, T0 + DAY)).is_ok());
}

#[test]
fn a_version_whose_envelope_the_store_lost_is_a_fault_not_a_missing_document() {
    let mut world = World::new();
    let shared = world.shared(T0);
    world.share.store.lose_envelopes();
    assert!(matches!(world.read(&shared.id, T0), Err(Refused::Store(_))));
}

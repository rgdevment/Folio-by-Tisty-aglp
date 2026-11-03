use tisty_share_proto::identity::{Root, ShareKey};

use super::*;

fn level_one() -> World {
    World::with(Policy {
        limits: Limits::default(),
        ..policy()
    })
}

fn with_photos(id: &str, version: u64, from: Option<u64>, photos: usize) -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(300, 1);
    let pictures: Vec<(Kind, &[u8])> = (0..photos).map(|_| (Kind::Png, png.as_slice())).collect();
    sealed_with(id, version, from, "con fotos", &pictures)
}

fn sealed_by_someone_else(id: &str, version: u64, from: Option<u64>, text: &str) -> Vec<u8> {
    let machine = ShareKey::from_bytes(&[6; 32]);
    let certificate = Root::from_bytes(&[4; 32]).certify(&machine.public(), Timestamp::UNIX_EPOCH);
    let draft = Draft {
        id,
        version,
        from,
        text,
        cited: &[],
        html: "<p>a</p>",
        config: Default::default(),
        pictures: &[],
    };
    let signer = Signer {
        key: &machine,
        certificate: &certificate,
        at: Timestamp::from_second(T0).unwrap(),
        name: None,
    };
    envelope::seal(&key(), &draft, Some(&signer), &Limits::default())
        .unwrap()
        .to_bytes()
}

fn first(world: &mut World, reserved: &Reserved, now: i64) -> Result<u64, Refused> {
    let bytes = sealed(&reserved.id, 1, None, "otra");
    world.put(&reserved.id, &reserved.edit, bytes, now)
}

#[test]
fn a_document_belongs_to_whoever_put_its_first_version_up_and_stays_theirs() {
    let mut world = level_one();
    let doc = world.shared(T0);
    let owner = world.doc(&doc.id).owner;
    assert_eq!(owner.len(), 64);

    let theirs = sealed_by_someone_else(&doc.id, 2, Some(1), "suya");
    assert_eq!(world.put(&doc.id, &doc.edit, theirs, T0), Ok(2));
    assert_eq!(world.doc(&doc.id).owner, owner);
}

#[test]
fn a_third_share_alive_is_refused_before_anything_is_kept() {
    let mut world = level_one();
    let one = world.shared(T0);
    world.shared(T0);
    let kept = world.share.store.envelopes();
    let third = world.reserve(T0);
    assert_eq!(first(&mut world, &third, T0), Err(Refused::SharesFull));
    assert_eq!(world.share.store.envelopes(), kept);
    assert!(world.doc(&third.id).versions.is_empty());
    assert!(world.doc(&third.id).owner.is_empty());

    let page = world.reserve(T0);
    world.manage(&one, hold(&page, false), T0).unwrap();
    assert_eq!(first(&mut world, &page, T0), Ok(1));
    assert_eq!(first(&mut world, &third, T0), Err(Refused::SharesFull));
}

#[test]
fn a_share_stopped_ended_or_held_by_another_alone_leaves_room_for_another() {
    let mut world = level_one();
    let one = world.shared(T0);
    let two = world.shared(T0);
    world.manage(&one, Manage::Delete, T0).unwrap();
    let three = world.reserve(T0);
    assert_eq!(first(&mut world, &three, T0), Ok(1));

    world.manage(&three, hold(&two, true), T0).unwrap();
    let four = world.reserve(T0);
    assert_eq!(first(&mut world, &four, T0), Err(Refused::SharesFull));
    world
        .manage(&three, Manage::Release(two.id.clone()), T0)
        .unwrap();
    world.manage(&three, hold(&two, false), T0).unwrap();
    assert_eq!(first(&mut world, &four, T0), Ok(1));

    let later = T0 + 16 * DAY;
    let five = world.reserve(later);
    assert_eq!(first(&mut world, &five, later), Ok(1));
}

#[test]
fn a_share_holds_as_many_pages_and_cited_documents_as_its_level_allows() {
    let mut world = level_one();
    let root = world.shared(T0);
    let pages: Vec<Reserved> = (0..3).map(|_| world.reserve(T0)).collect();
    world.manage(&root, hold(&pages[0], false), T0).unwrap();
    world.manage(&root, hold(&pages[1], false), T0).unwrap();
    assert_eq!(
        world.manage(&root, hold(&pages[2], false), T0),
        Err(Refused::TooLong)
    );
}

#[test]
fn a_page_held_before_its_first_version_keeps_its_reserved_hour_until_it_is_written() {
    let mut world = level_one();
    let root = world.shared(T0);
    let never = world.reserve(T0);
    let written = world.reserve(T0);
    world.manage(&root, hold(&never, true), T0).unwrap();
    world.manage(&root, hold(&written, false), T0).unwrap();
    assert_eq!(world.doc(&never.id).own, None);
    assert_eq!(world.doc(&never.id).ends, T0 + world.share.policy.reserved);
    assert_eq!(first(&mut world, &written, T0), Ok(1));
    assert_eq!(world.doc(&written.id).ends, crate::holding::HELD);

    let past_reserved = T0 + 2 * HOUR;
    done(world.share.sweep(past_reserved)).unwrap();
    assert_eq!(world.read(&never.id, past_reserved), Err(Refused::Missing));
    assert_eq!(world.doc(&root.id).holds, vec![written.id.clone()]);
    assert!(world.read(&written.id, past_reserved).is_ok());

    world
        .manage(&root, Manage::Release(written.id.clone()), past_reserved)
        .unwrap();
    assert_eq!(
        world.read(&written.id, past_reserved),
        Err(Refused::Missing)
    );
}

#[test]
fn a_page_still_held_goes_with_its_holder() {
    let mut world = level_one();
    let root = world.shared(T0);
    let page = world.reserve(T0);
    world.manage(&root, hold(&page, false), T0).unwrap();
    assert_eq!(first(&mut world, &page, T0), Ok(1));
    let gone = T0 + 16 * DAY;
    done(world.share.sweep(gone)).unwrap();
    assert_eq!(world.read(&page.id, gone), Err(Refused::Missing));
}

#[test]
fn a_document_with_no_version_yet_cannot_be_kept_alive_by_its_management_link() {
    let mut world = level_one();
    let reserved = world.reserve(T0);
    for what in [
        Manage::Visit,
        Manage::Idle(60),
        Manage::Pause,
        Manage::Restore,
        Manage::Password(Some("clave".into())),
    ] {
        assert_eq!(world.manage(&reserved, what, T0), Err(Refused::Unwritten));
    }
    assert_eq!(
        world.doc(&reserved.id).ends,
        T0 + world.share.policy.reserved
    );
    assert_eq!(world.manage(&reserved, Manage::Delete, T0), Ok(()));
}

#[test]
fn a_hold_left_halfway_is_finished_when_asked_again_at_the_level_s_edge() {
    let mut world = level_one();
    let root = world.shared(T0);
    let pages: Vec<Reserved> = (0..2).map(|_| world.reserve(T0)).collect();
    for page in &pages {
        world.manage(&root, hold(page, false), T0).unwrap();
    }
    let mut halfway = world.doc(&pages[1].id);
    halfway.holders.clear();
    let revision = halfway.revision;
    done(world.share.store.save(&halfway, Some(revision))).unwrap();

    world.manage(&root, hold(&pages[1], false), T0).unwrap();
    assert_eq!(world.doc(&pages[1].id).holders, vec![root.id.clone()]);
}

#[test]
fn the_pictures_of_a_share_and_its_pages_add_up_to_its_level() {
    let mut world = level_one();
    let root = world.reserve(T0);
    let pages: Vec<Reserved> = (0..2).map(|_| world.reserve(T0)).collect();
    for page in &pages {
        world.manage(&root, hold(page, false), T0).unwrap();
        let bytes = with_photos(&page.id, 1, None, 1);
        assert_eq!(world.put(&page.id, &page.edit, bytes, T0), Ok(1));
    }
    let crowded = with_photos(&root.id, 1, None, 1);
    let unworked = world.proof(Ask::Reserve, T0);
    assert_eq!(
        done(
            world
                .share
                .upload(&root.id, &root.edit, crowded, HERE, &unworked, T0)
        ),
        Err(Refused::PicturesFull)
    );
    assert_eq!(first(&mut world, &root, T0), Ok(1));

    let more = with_photos(&pages[0].id, 2, Some(1), 2);
    assert_eq!(
        world.put(&pages[0].id, &pages[0].edit, more, T0),
        Err(Refused::PicturesFull)
    );
    let fewer = with_photos(&pages[0].id, 2, Some(1), 0);
    assert_eq!(world.put(&pages[0].id, &pages[0].edit, fewer, T0), Ok(2));
    let back = with_photos(&pages[1].id, 2, Some(1), 2);
    assert_eq!(world.put(&pages[1].id, &pages[1].edit, back, T0), Ok(2));
}

#[test]
fn holding_a_document_whose_pictures_pass_the_share_s_level_is_refused() {
    let mut world = level_one();
    let root = world.reserve(T0);
    let bytes = with_photos(&root.id, 1, None, 2);
    assert_eq!(world.put(&root.id, &root.edit, bytes, T0), Ok(1));
    let pictured = world.reserve(T0);
    let bytes = with_photos(&pictured.id, 1, None, 1);
    assert_eq!(world.put(&pictured.id, &pictured.edit, bytes, T0), Ok(1));
    assert_eq!(
        world.manage(&root, hold(&pictured, true), T0),
        Err(Refused::PicturesFull)
    );
    assert!(world.doc(&root.id).holds.is_empty());

    let plain = world.reserve(T0);
    world.manage(&root, hold(&plain, false), T0).unwrap();
}

fn with_pages(world: &mut World) -> (Reserved, Vec<Reserved>) {
    let root = world.reserve(T0);
    let pages: Vec<Reserved> = (0..2).map(|_| world.reserve(T0)).collect();
    for page in &pages {
        world.manage(&root, hold(page, false), T0).unwrap();
        assert_eq!(first(world, page, T0), Ok(1));
    }
    assert_eq!(first(world, &root, T0), Ok(1));
    (root, pages)
}

fn read_worked(world: &mut World, id: &str, caller: IpAddr, now: i64) -> Result<Served, Refused> {
    let proof = world.proof(Ask::Reader { id }, now);
    let (served, seen) = done(world.share.read(id, None, Some(&proof), false, caller, now))?;
    done(world.share.seen(seen))?;
    Ok(served)
}

fn counted_for(world: &World, doc: &Reserved, now: i64) -> u64 {
    let owner = world.doc(&doc.id).owner;
    let counter = format!("readers:{owner}:{}", now.div_euclid(DAY));
    done(world.share.store.counted(&counter, now)).unwrap()
}

#[test]
fn a_reader_of_a_share_and_its_pages_counts_once_for_their_owner() {
    let mut world = level_one();
    let (root, pages) = with_pages(&mut world);
    for doc in std::iter::once(&root).chain(&pages) {
        world.read_from(&doc.id, None, there(1), T0).unwrap();
        assert_eq!(world.doc(&doc.id).reads, 1);
    }
    assert_eq!(counted_for(&world, &root, T0), 1);

    let home = |n: u16| IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 7, n, 0, 0, 0, 1));
    world.read_from(&root.id, None, home(1), T0).unwrap();
    world.read_from(&pages[0].id, None, home(2), T0).unwrap();
    assert_eq!(world.doc(&root.id).reads, 2);
    assert_eq!(counted_for(&world, &root, T0), 2);
}

#[test]
fn past_an_owner_s_readers_a_day_a_new_reader_works_a_moment_and_is_let_in() {
    let mut world = level_one();
    let (root, pages) = with_pages(&mut world);
    let two = world.shared(T0);
    for n in 0..200 {
        world.read_from(&root.id, None, there(n), T0).unwrap();
    }
    for n in 200..250 {
        world.read_from(&two.id, None, there(n), T0).unwrap();
    }
    let everywhere = [&root, &pages[0], &pages[1], &two];
    for doc in everywhere {
        assert_eq!(
            world.read_from(&doc.id, None, there(250), T0),
            Err(Refused::WorkAsked)
        );
        assert!(world.read_from(&doc.id, None, there(7), T0).is_ok());
    }
    assert!(read_worked(&mut world, &pages[1].id, there(250), T0).is_ok());
    assert_eq!(counted_for(&world, &root, T0), 251);
    for doc in everywhere {
        assert!(world.read_from(&doc.id, None, there(250), T0).is_ok());
    }
    let tomorrow = (T0.div_euclid(DAY) + 1) * DAY;
    assert!(
        world
            .read_from(&pages[0].id, None, there(251), tomorrow)
            .is_ok()
    );

    let theirs = world.reserve(T0);
    let bytes = sealed_by_someone_else(&theirs.id, 1, None, "suya");
    assert_eq!(world.put(&theirs.id, &theirs.edit, bytes, T0), Ok(1));
    assert!(world.read_from(&theirs.id, None, there(252), T0).is_ok());
}

#[test]
fn past_an_owner_s_readers_a_day_one_password_proof_also_lets_a_new_reader_in() {
    let mut world = level_one();
    let root = world.shared(T0);
    world
        .manage(&root, Manage::Password(Some("perro azul".into())), T0)
        .unwrap();
    for n in 0..250 {
        world
            .read_from(&root.id, Some("perro azul"), there(n), T0)
            .unwrap();
    }
    assert_eq!(
        world.read_from(&root.id, Some("perro azul"), there(250), T0),
        Err(Refused::WorkAsked)
    );
    let proof = world.proof(Ask::Password { id: &root.id }, T0);
    assert!(
        world
            .read_worked(&root.id, "perro azul", &proof, there(250), T0)
            .is_ok()
    );
}

fn reserved_in(share: &mut Share<Faulty, Counting>) -> Reserved {
    let proof = work::solve(&done(share.challenge(Ask::Reserve, HERE, T0)).unwrap()).unwrap();
    done(share.reserve(HERE, &proof, T0)).unwrap()
}

fn faulty_one() -> Share<Faulty, Counting> {
    let mut share = faulty();
    share.policy.limits = Limits::default();
    share
}

#[test]
fn a_share_that_raced_past_its_owner_s_level_is_taken_back() {
    let mut share = faulty_one();
    let one = reserved_in(&mut share);
    upload_faulty(&mut share, &one, sealed(&one.id, 1, None, "uno")).unwrap();
    let two = reserved_in(&mut share);
    let mut rival = done(share.store.inner.doc(&one.id)).unwrap().unwrap();
    rival.id = "rivalAa1".into();
    *share.store.racing.borrow_mut() = Some(rival);
    let kept = share.store.inner.envelopes();
    assert_eq!(
        upload_faulty(&mut share, &two, sealed(&two.id, 1, None, "dos")),
        Err(Refused::SharesFull)
    );
    assert_eq!(done(share.store.doc(&two.id)).unwrap(), None);
    assert_eq!(share.store.inner.envelopes(), kept);
}

#[test]
fn a_version_that_raced_past_its_share_s_pictures_is_taken_back() {
    let mut share = faulty_one();
    let root = reserved_in(&mut share);
    let pages = [reserved_in(&mut share), reserved_in(&mut share)];
    for page in &pages {
        let held = hold(page, false);
        done(share.manage(&root.id, &root.admin, held, T0)).unwrap();
        upload_faulty(&mut share, page, with_photos(&page.id, 1, None, 0)).unwrap();
    }
    upload_faulty(&mut share, &root, sealed(&root.id, 1, None, "raíz")).unwrap();
    let mut rival = done(share.store.doc(&pages[0].id)).unwrap().unwrap();
    rival.versions.last_mut().unwrap().pictures = 2;
    *share.store.racing.borrow_mut() = Some(rival);
    let kept = share.store.inner.envelopes();
    let more = with_photos(&pages[1].id, 2, Some(1), 1);
    assert_eq!(
        upload_faulty(&mut share, &pages[1], more),
        Err(Refused::PicturesFull)
    );
    let back = done(share.store.doc(&pages[1].id)).unwrap().unwrap();
    assert_eq!(back.latest(), Some(1));
    assert_eq!(share.store.inner.envelopes(), kept);
}

#[test]
fn a_blocked_share_leaves_room_for_another_and_a_paused_one_does_not() {
    let mut world = level_one();
    let one = world.shared(T0);
    let two = world.shared(T0);
    world.manage(&one, Manage::Pause, T0).unwrap();
    let third = world.reserve(T0);
    assert_eq!(first(&mut world, &third, T0), Err(Refused::SharesFull));

    for n in 1..=3 {
        world.report_from(&two.id, there(n), T0).unwrap();
    }
    assert!(world.doc(&two.id).blocked.is_some());
    assert_eq!(first(&mut world, &third, T0), Ok(1));
}

use std::net::{IpAddr, Ipv4Addr};

use serde_json::Value;
use tisty_share_proto::envelope::{self, Draft, Envelope, LinkKey};
use tisty_share_proto::work::{self, Challenge};
use tisty_share_server::guard::{Allowance, Work};
use tisty_share_server::keys::Slowness;
use tisty_share_server::memory::Memory;
use tisty_share_server::share::Policy;
use tisty_share_server::testing::{Counting, done};

use super::*;

const T0: i64 = 1_800_000_000;
const HERE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));

/// Little work and a quick password, so the tests run quickly.
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

fn sealed(id: &str, version: u64, from: Option<u64>) -> Vec<u8> {
    let draft = Draft {
        id,
        version,
        from,
        text: "hola",
        pictures: &[],
    };
    envelope::seal(
        &LinkKey::from_bytes(&[9; 32]),
        &draft,
        None,
        &Limits::default(),
    )
    .unwrap()
    .to_bytes()
}

fn asked(method: &str, path: &str) -> Asked {
    Asked {
        method: method.into(),
        path: path.into(),
        token: None,
        password: None,
        work: None,
        body: Vec::new(),
        caller: HERE,
        now: T0,
    }
}

fn header<'a>(answer: &'a Answer, name: &str) -> Option<&'a str> {
    answer
        .headers
        .iter()
        .find(|(said, _)| *said == name)
        .map(|(_, value)| value.as_str())
}

fn said(answer: &Answer) -> Value {
    serde_json::from_slice(&answer.body).unwrap()
}

fn place(n: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(198, 51, 100, n))
}

struct World {
    share: Share<Memory, Counting>,
}

/// A document reserved and shared once, as a Tisty does it over HTTP.
struct Shared {
    id: String,
    edit: String,
    admin: String,
    first: Vec<u8>,
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

    fn answer(&mut self, asked: Asked) -> Answer {
        done(answer(&mut self.share, asked))
    }

    fn work(&mut self, asking: Value) -> String {
        let mut asked = asked("POST", "/api/v1/challenge");
        asked.body = asking.to_string().into_bytes();
        let answer = self.answer(asked);
        assert_eq!(answer.status, 200, "{}", said(&answer));
        let challenge: Challenge = serde_json::from_slice(&answer.body).unwrap();
        serde_json::to_string(&work::solve(&challenge).unwrap()).unwrap()
    }

    fn put(&mut self, id: &str, edit: &str, bytes: Vec<u8>) -> Answer {
        let digest = Envelope::read(bytes.clone(), &Limits::default())
            .unwrap()
            .digest();
        let work = self.work(json!({
            "for": "upload",
            "id": id,
            "digest": URL_SAFE_NO_PAD.encode(digest),
            "bytes": bytes.len(),
        }));
        let mut asked = asked("PUT", &format!("/api/v1/docs/{id}"));
        asked.token = Some(edit.into());
        asked.work = Some(work);
        asked.body = bytes;
        self.answer(asked)
    }

    fn shared(&mut self) -> Shared {
        let work = self.work(json!({ "for": "reserve" }));
        let mut asked = asked("POST", "/api/v1/docs");
        asked.work = Some(work);
        let reserved = self.answer(asked);
        assert_eq!(reserved.status, 201);
        let links = said(&reserved);
        let id: String = links["id"].as_str().unwrap().into();
        let edit: String = links["edit"].as_str().unwrap().into();
        let first = sealed(&id, 1, None);
        let put = self.put(&id, &edit, first.clone());
        assert_eq!(said(&put), json!({ "version": 1 }));
        Shared {
            admin: links["admin"].as_str().unwrap().into(),
            id,
            edit,
            first,
        }
    }

    fn manage(&mut self, shared: &Shared, what: Value) -> Answer {
        let mut asked = asked("POST", &format!("/api/v1/docs/{}/manage", shared.id));
        asked.token = Some(shared.admin.clone());
        asked.body = what.to_string().into_bytes();
        self.answer(asked)
    }

    fn report_from(&mut self, id: &str, caller: IpAddr, category: &str) -> Answer {
        let work = self.work(json!({ "for": "report", "id": id }));
        let mut asked = asked("POST", &format!("/api/v1/docs/{id}/reports"));
        asked.caller = caller;
        asked.work = Some(work);
        asked.body = json!({ "category": category, "detail": "pide la clave" })
            .to_string()
            .into_bytes();
        self.answer(asked)
    }

    fn appeal(&mut self, shared: &Shared) -> Answer {
        let mut asked = asked("POST", &format!("/api/v1/docs/{}/appeal", shared.id));
        asked.token = Some(shared.admin.clone());
        asked.body = json!({ "detail": "es mío y es legal" })
            .to_string()
            .into_bytes();
        self.answer(asked)
    }
}

#[test]
fn a_document_is_reserved_shared_and_read_over_http() {
    let mut world = World::new();
    let shared = world.shared();

    let read = world.answer(asked("GET", &format!("/api/v1/docs/{}", shared.id)));
    assert_eq!(read.status, 200);
    assert_eq!(read.body, shared.first);
    assert_eq!(header(&read, "Tisty-Version"), Some("1"));
    assert_eq!(
        header(&read, "Content-Type"),
        Some("application/octet-stream")
    );
    let latest = world.answer(asked("GET", &format!("/api/v1/docs/{}/latest", shared.id)));
    assert_eq!(said(&latest), json!({ "latest": 1 }));
}

#[test]
fn every_answer_keeps_itself_out_of_caches_and_search_engines() {
    let mut world = World::new();
    for answer in [
        world.answer(asked("GET", "/api/v1/limits")),
        world.answer(asked("GET", "/api/v1/docs/nothing")),
        world.answer(asked("GET", "/api/v1/elsewhere")),
    ] {
        assert_eq!(header(&answer, "Cache-Control"), Some("no-store"));
        assert_eq!(header(&answer, "X-Robots-Tag"), Some("noindex, nofollow"));
        assert_eq!(header(&answer, "Referrer-Policy"), Some("no-referrer"));
        assert!(header(&answer, "Strict-Transport-Security").is_some());
    }
    let robots = world.answer(asked("GET", "/robots.txt"));
    assert_eq!(robots.body, b"User-agent: *\nDisallow: /\n");
}

#[test]
fn the_domain_itself_goes_home_for_good_and_any_other_page_for_now() {
    let mut world = World::new();
    let root = world.answer(asked("GET", "/"));
    assert_eq!(root.status, 301);
    assert_eq!(header(&root, "Location"), Some("https://www.tisty.app/"));
    assert!(root.body.is_empty());

    for path in ["/abcd1234", "/favicon.ico", "/a/b"] {
        let page = world.answer(asked("GET", path));
        assert_eq!(page.status, 302, "{path}");
        assert_eq!(header(&page, "Location"), Some("https://www.tisty.app/"));
    }
    assert_eq!(world.answer(asked("HEAD", "/")).status, 301);

    // The API keeps its own words, and nothing but reading is ever sent away.
    let missing = world.answer(asked("GET", "/api/v1/nothing"));
    assert_eq!(said(&missing), json!({ "refused": "unknown" }));
    assert_eq!(world.answer(asked("POST", "/")).status, 404);
    assert_eq!(world.answer(asked("GET", "/robots.txt")).status, 200);
}

#[test]
fn the_limits_are_the_server_s_own_and_read_as_tisty_reads_them() {
    let mut world = World::with(Policy {
        limits: Limits {
            pictures: 0,
            ..Limits::default()
        },
        ..policy()
    });
    let answer = world.answer(asked("GET", "/api/v1/limits"));
    let limits: Limits = serde_json::from_slice(&answer.body).unwrap();
    assert_eq!(limits.pictures, 0);
    assert_eq!(limits.text, Limits::default().text);
}

#[test]
fn refusals_come_back_as_a_status_and_a_word() {
    let mut world = World::new();
    let shared = world.shared();
    let missing = world.answer(asked("GET", "/api/v1/docs/nothing"));
    assert_eq!(
        (missing.status, said(&missing)),
        (404, json!({ "refused": "missing" }))
    );

    let unknown = world.answer(asked("DELETE", "/api/v1/limits"));
    assert_eq!(said(&unknown), json!({ "refused": "unknown" }));

    let mut unreadable = asked("POST", "/api/v1/challenge");
    unreadable.body = b"{".to_vec();
    assert_eq!(world.answer(unreadable).status, 400);

    let mut without_work = asked("PUT", &format!("/api/v1/docs/{}", shared.id));
    without_work.token = Some(shared.edit.clone());
    let refused = world.answer(without_work);
    assert_eq!(
        (refused.status, said(&refused)),
        (403, json!({ "refused": "work_refused" }))
    );

    let behind = world.put(&shared.id, &shared.edit, sealed(&shared.id, 1, None));
    assert_eq!(
        (behind.status, said(&behind)),
        (409, json!({ "refused": "behind", "latest": 1 }))
    );

    let mut not_the_owner = asked("GET", &format!("/api/v1/docs/{}/info", shared.id));
    not_the_owner.token = Some(shared.edit.clone());
    assert_eq!(world.answer(not_the_owner).status, 403);
}

#[test]
fn going_past_an_allowance_says_how_long_to_wait() {
    let mut world = World::with(Policy {
        allowance: Allowance {
            reads: 1,
            ..Allowance::default()
        },
        ..policy()
    });
    let shared = world.shared();
    let path = format!("/api/v1/docs/{}", shared.id);
    world.answer(asked("GET", &path));
    let mut later = asked("GET", &path);
    later.now = T0 + 600;
    let slow = world.answer(later);

    assert_eq!(slow.status, 429);
    assert_eq!(
        said(&slow),
        json!({ "refused": "slow", "until": T0 + 3_600 })
    );
    assert_eq!(header(&slow, "Retry-After"), Some("3000"));
}

#[test]
fn a_password_travels_in_its_own_header_and_is_asked_for_by_name() {
    let mut world = World::new();
    let shared = world.shared();
    let set = world.manage(&shared, json!({ "do": "password", "with": "perro azul" }));
    assert_eq!(set.status, 204);

    let path = format!("/api/v1/docs/{}", shared.id);
    let asked_for = world.answer(asked("GET", &path));
    assert_eq!(asked_for.status, 401);
    assert_eq!(said(&asked_for), json!({ "refused": "password_asked" }));
    assert_eq!(
        header(&asked_for, "WWW-Authenticate"),
        Some("Tisty-Password")
    );

    let mut with_it = asked("GET", &path);
    with_it.password = Some("perro azul".into());
    assert_eq!(world.answer(with_it).body, shared.first);
}

#[test]
fn the_owner_sees_the_card_and_the_editors_see_earlier_versions() {
    let mut world = World::new();
    let shared = world.shared();
    let second = sealed(&shared.id, 2, Some(1));
    assert_eq!(world.put(&shared.id, &shared.edit, second).status, 200);

    let mut info = asked("GET", &format!("/api/v1/docs/{}/info", shared.id));
    info.token = Some(shared.admin.clone());
    let card = said(&world.answer(info));
    assert_eq!(card["latest"], json!(2));
    assert_eq!(card["gated"], json!(false));

    let mut earlier = asked("GET", &format!("/api/v1/docs/{}/versions/1", shared.id));
    earlier.token = Some(shared.edit.clone());
    let served = world.answer(earlier);
    assert_eq!(header(&served, "Tisty-Version"), Some("1"));
    assert_eq!(served.body, shared.first);

    assert_eq!(world.manage(&shared, json!({ "do": "pause" })).status, 204);
    let read = world.answer(asked("GET", &format!("/api/v1/docs/{}", shared.id)));
    assert_eq!(said(&read), json!({ "refused": "paused" }));
}

#[test]
fn three_places_reporting_block_the_document_and_its_owner_appeals_once() {
    let mut world = World::new();
    let shared = world.shared();
    let appeal_as_a_reader = world.report_from(&shared.id, place(1), "appeal");
    assert_eq!(appeal_as_a_reader.status, 403);
    for n in 1..=3 {
        let reported = world.report_from(&shared.id, place(n), "phishing");
        assert_eq!(reported.status, 204);
    }
    let again = world.report_from(&shared.id, place(1), "phishing");
    assert_eq!(said(&again), json!({ "refused": "reported" }));

    let read = world.answer(asked("GET", &format!("/api/v1/docs/{}", shared.id)));
    assert_eq!(
        (read.status, said(&read)),
        (451, json!({ "refused": "blocked" }))
    );
    assert_eq!(world.appeal(&shared).status, 204);
    assert_eq!(
        said(&world.appeal(&shared)),
        json!({ "refused": "reported" })
    );
}

#[test]
fn a_host_that_cannot_reach_a_step_still_answers_as_every_answer_does() {
    let broken = broken("SHARE_SECRET is missing".into());
    assert_eq!(broken.status, 500);
    assert_eq!(said(&broken), json!({ "refused": "unready" }));
    assert_eq!(broken.fault.as_deref(), Some("SHARE_SECRET is missing"));
    assert_eq!(header(&broken, "Cache-Control"), Some("no-store"));
    assert_eq!(header(&broken, "X-Robots-Tag"), Some("noindex, nofollow"));
}

#[test]
fn a_body_too_large_to_be_any_envelope_is_turned_away_unread() {
    let limits = Limits::default();
    let ceiling = limits.text + limits.all_pictures + 64 * 1024;
    assert!(too_large(&limits, ceiling).is_none());
    let refused = too_large(&limits, ceiling + 1).unwrap();
    assert_eq!(refused.status, 413);
    assert_eq!(header(&refused, "Cache-Control"), Some("no-store"));
}

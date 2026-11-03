use rusqlite::{Connection, params};

use super::*;

fn started() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../migrations/0001_start.sql"))
        .unwrap();
    db.execute_batch(include_str!("../migrations/0002_revocations.sql"))
        .unwrap();
    db.execute_batch(include_str!("../migrations/0003_owners.sql"))
        .unwrap();
    db
}

fn counted(db: &Connection, key: &str, by: i64, until: i64, now: i64) -> i64 {
    db.query_row(COUNT, params![key, by, until, now], |row| row.get(0))
        .unwrap()
}

#[test]
fn a_counter_adds_until_it_lapses_and_then_starts_again() {
    let db = started();
    assert_eq!(counted(&db, "rate", 1, 100, 10), 1);
    assert_eq!(counted(&db, "rate", 1, 500, 20), 2);
    assert_eq!(counted(&db, "rate", 0, 500, 100), 2);
    // Its own end holds while it runs; a later one is taken only once it lapsed.
    assert_eq!(counted(&db, "rate", 3, 500, 101), 3);
    assert_eq!(counted(&db, "rate", 1, 900, 600), 1);
}

#[test]
fn looking_at_a_counter_writes_nothing_and_a_lapsed_one_reads_as_none() {
    let db = started();
    let looked = |key: &str, now: i64| -> i64 {
        db.query_row(COUNTED, params![key, now], |row| row.get(0))
            .unwrap_or(0)
    };
    assert_eq!(looked("rate", 10), 0);
    let rows: i64 = db
        .query_row("SELECT count(*) FROM counters", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    counted(&db, "rate", 2, 100, 10);
    assert_eq!(looked("rate", 50), 2);
    assert_eq!(looked("rate", 101), 0);
}

#[test]
fn a_document_is_saved_first_once_and_after_only_on_its_revision() {
    let db = started();
    let insert = |body: &str| db.execute(INSERT_DOC, params!["abc", 0, 50, body]).unwrap();
    assert_eq!(insert("[1]"), 1);
    assert_eq!(insert("[2]"), 0);

    let update = |revision: i64, was: i64| {
        db.execute(UPDATE_DOC, params!["abc", revision, 60, "[3]", was])
            .unwrap()
    };
    assert_eq!(update(1, 0), 1);
    assert_eq!(update(1, 0), 0);
    let body: String = db.query_row(DOC, params!["abc"], |row| row.get(0)).unwrap();
    assert_eq!(body, "[3]");

    let ending = |now: i64| -> Vec<String> {
        let mut asked = db.prepare(ENDING).unwrap();
        asked
            .query_map(params![now, 10], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert!(ending(60).is_empty());
    assert_eq!(ending(61), ["abc"]);
    db.execute(FORGET, params!["abc"]).unwrap();
    assert!(ending(61).is_empty());
}

#[test]
fn a_mark_is_made_once_while_it_holds_and_again_once_it_lapsed() {
    let db = started();
    let mark = |until: i64, now: i64| db.execute(MARK, params!["seen:x", until, now]).unwrap();
    assert_eq!(mark(100, 10), 1);
    assert_eq!(mark(100, 50), 0);
    assert_eq!(mark(100, 100), 0);
    assert_eq!(mark(300, 101), 1);
    let until: i64 = db
        .query_row("SELECT until FROM holds WHERE key = 'seen:x'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(until, 300);
}

#[test]
fn a_lapse_lets_go_of_a_few_thousand_at_a_time() {
    let db = started();
    for n in 0..5_001 {
        db.execute(HOLD, params![format!("seen:{n}"), 10]).unwrap();
    }
    db.execute(LAPSE[1], params![11]).unwrap();
    let left: i64 = db
        .query_row("SELECT count(*) FROM holds", [], |row| row.get(0))
        .unwrap();
    assert_eq!(left, 1);
}

#[test]
fn holds_and_reports_last_until_their_moment_and_then_lapse() {
    let db = started();
    db.execute(HOLD, params!["wait:x", 100]).unwrap();
    db.execute(HOLD, params!["wait:x", 200]).unwrap();
    let held = |now: i64| -> Option<i64> {
        db.query_row(HELD, params!["wait:x", now], |row| row.get(0))
            .ok()
    };
    assert_eq!(held(200), Some(200));
    assert_eq!(held(201), None);

    db.execute(FILE, params!["abc", 300, "one"]).unwrap();
    db.execute(FILE, params!["abc", 900, "two"]).unwrap();
    db.execute(FILE, params!["other", 900, "three"]).unwrap();
    let reports = |now: i64| -> Vec<String> {
        let mut asked = db.prepare(REPORTS).unwrap();
        asked
            .query_map(params!["abc", now], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(reports(300), ["one", "two"]);
    assert_eq!(reports(301), ["two"]);

    counted(&db, "rate", 1, 250, 0);
    for statement in LAPSE {
        db.execute(statement, params![301]).unwrap();
    }
    let left: i64 = db
        .query_row(
            "SELECT (SELECT count(*) FROM counters) + (SELECT count(*) FROM holds) \
             + (SELECT count(*) FROM reports)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 2);
}

#[test]
fn a_revocation_is_kept_once_per_root_and_key_and_read_back_by_both() {
    let db = started();
    let revoke = |share: &str, root: &str, body: &str| {
        db.execute(REVOKE, params![share, root, body]).unwrap()
    };
    assert_eq!(revoke("k1", "r1", "first"), 1);
    assert_eq!(revoke("k1", "r1", "again"), 0);
    assert_eq!(revoke("k1", "r2", "other"), 1);
    assert_eq!(revoke("k2", "r1", "elsewhere"), 1);

    let said = |share: &str, root: &str| -> Option<String> {
        db.query_row(REVOCATION, params![share, root], |row| row.get(0))
            .ok()
    };
    assert_eq!(said("k1", "r1").as_deref(), Some("first"));
    assert_eq!(said("k1", "r2").as_deref(), Some("other"));
    assert_eq!(said("k2", "r2"), None);
}

#[test]
fn the_census_counts_documents_whole_by_how_they_stand() {
    let db = started();
    let census = |now: i64| -> Vec<i64> {
        db.query_row(CENSUS, params![now], |row| {
            (0..9)
                .map(|at| row.get(at))
                .collect::<Result<Vec<i64>, _>>()
        })
        .unwrap()
    };
    assert_eq!(
        census(0),
        vec![0; 9],
        "an empty service counts zeros, not nulls"
    );
    let doc = |id: &str, ends: i64, body: &str| {
        db.execute(INSERT_DOC, params![id, 0, ends, body]).unwrap();
    };
    doc(
        "a",
        100,
        r#"{"versions":[],"gate":null,"paused":null,"blocked":null,"reads":0}"#,
    );
    doc(
        "b",
        50_000,
        r#"{"versions":[1],"gate":{"salt":1},"paused":7,"blocked":null,"reads":3,"holders":["x"]}"#,
    );
    doc(
        "c",
        900_000,
        r#"{"versions":[1],"gate":null,"paused":null,"blocked":9,"reads":2}"#,
    );
    // docs, unwritten, gated, paused, blocked, held, ending in a day, in a week, reads
    assert_eq!(census(0), vec![3, 1, 1, 1, 1, 1, 2, 2, 5]);
}

#[test]
fn an_owner_s_shares_are_those_alive_written_and_held_by_nothing() {
    let db = started();
    let doc = |id: &str, ends: i64, body: &str| {
        db.execute(INSERT_DOC, params![id, 0, ends, body]).unwrap();
    };
    doc("a", 100, r#"{"owner":"o1","versions":[1]}"#);
    doc("b", 500, r#"{"owner":"o1","versions":[]}"#);
    doc("c", 500, r#"{"owner":"o1","versions":[1],"holders":["x"]}"#);
    doc("d", 500, r#"{"owner":"o2","versions":[1]}"#);
    doc("e", 500, r#"{"owner":"o1","versions":[1],"holders":[]}"#);
    doc("f", 500, r#"{"versions":[1]}"#);
    doc("g", 500, r#"{"owner":"o1","versions":[1],"blocked":9}"#);
    doc(
        "h",
        500,
        r#"{"owner":"o1","versions":[1],"paused":7,"blocked":null}"#,
    );
    doc(
        "i",
        253_402_300_799,
        r#"{"owner":"o1","versions":[1],"holders":["x"],"own":300}"#,
    );
    let shares = |owner: &str, now: i64| -> i64 {
        db.query_row(SHARES_OF, params![owner, now], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(shares("o1", 100), 4);
    assert_eq!(shares("o1", 101), 3);
    assert_eq!(shares("o1", 301), 2);
    assert_eq!(shares("o2", 101), 1);
    assert_eq!(shares("o3", 0), 0);
}

#[test]
fn an_owner_s_shares_are_found_through_the_index_on_their_owner() {
    let db = started();
    let plan: Vec<String> = db
        .prepare(&format!("EXPLAIN QUERY PLAN {SHARES_OF}"))
        .unwrap()
        .query_map(params!["o1", 0], |row| row.get(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        plan.iter().any(|step| step.contains("docs_by_owner")),
        "{plan:?}"
    );
}

use rusqlite::{Connection, params};

use super::*;

fn started() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../migrations/0001_start.sql"))
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
fn a_document_is_saved_first_once_and_after_only_on_its_revision() {
    let db = started();
    let insert = |body: &str| db.execute(INSERT_DOC, params!["abc", 0, 50, body]).unwrap();
    assert_eq!(insert("first"), 1);
    assert_eq!(insert("second"), 0);

    let update = |revision: i64, was: i64| {
        db.execute(UPDATE_DOC, params!["abc", revision, 60, "later", was])
            .unwrap()
    };
    assert_eq!(update(1, 0), 1);
    assert_eq!(update(1, 0), 0);
    let body: String = db.query_row(DOC, params!["abc"], |row| row.get(0)).unwrap();
    assert_eq!(body, "later");

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

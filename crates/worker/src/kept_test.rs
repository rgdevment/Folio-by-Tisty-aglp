use rusqlite::types::Value as Cell;
use rusqlite::{Connection, Params, params};
use serde::de::DeserializeOwned;
use serde_json::{Map, json};
use tisty_share_server::store::Doc;

use super::*;
use crate::sql;

fn started() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../migrations/0001_start.sql"))
        .unwrap();
    db
}

/// Each row as D1 hands it to the Worker: an object named by its columns.
fn rows<T: DeserializeOwned>(db: &Connection, query: &str, values: impl Params) -> Vec<T> {
    let mut asked = db.prepare(query).unwrap();
    let names: Vec<String> = asked
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    asked
        .query_map(values, |row| {
            let mut object = Map::new();
            for (at, name) in names.iter().enumerate() {
                let cell = match row.get::<_, Cell>(at)? {
                    Cell::Integer(number) => json!(number),
                    Cell::Text(text) => json!(text),
                    Cell::Real(number) => json!(number),
                    Cell::Null | Cell::Blob(_) => serde_json::Value::Null,
                };
                object.insert(name.clone(), cell);
            }
            Ok(serde_json::Value::Object(object))
        })
        .unwrap()
        .map(|row| serde_json::from_value(row.unwrap()).unwrap())
        .collect()
}

fn doc(id: &str) -> Doc {
    Doc {
        id: id.into(),
        edit: [1; 32],
        admin: [2; 32],
        gate: None,
        versions: vec![Kept {
            version: 1,
            digest: [3; 32],
        }],
        created: 10,
        active: 10,
        idle: 100,
        ends: 110,
        paused: None,
        blocked: None,
        reads: 4,
        written: None,
        revision: 0,
    }
}

#[test]
fn every_query_names_the_columns_its_row_is_read_by() {
    let db = started();
    let kept = doc("abc");
    let body = serde_json::to_string(&kept).unwrap();
    db.execute(sql::INSERT_DOC, params!["abc", 0, 110, body])
        .unwrap();

    let held: Vec<Body> = rows(&db, sql::DOC, params!["abc"]);
    let read: Doc = serde_json::from_str(&held[0].body).unwrap();
    assert_eq!(read, kept);
    let ending: Vec<Id> = rows(&db, sql::ENDING, params![111, 10]);
    assert_eq!(ending[0].id, "abc");

    let counted: Vec<Value> = rows(&db, sql::COUNT, params!["rate", 2, 50, 0]);
    assert_eq!(counted[0].value, 2);
    db.execute(sql::HOLD, params!["wait", 70]).unwrap();
    let held: Vec<Until> = rows(&db, sql::HELD, params!["wait", 0]);
    assert_eq!(held[0].until, 70);
    db.execute(sql::FILE, params!["abc", 90, "report"]).unwrap();
    let reports: Vec<Body> = rows(&db, sql::REPORTS, params!["abc", 0]);
    assert_eq!(reports[0].body, "report");
}

#[test]
fn a_document_s_envelopes_share_a_prefix_no_other_document_s_starts_with() {
    let kept = Kept {
        version: 3,
        digest: [7; 32],
    };
    let key = envelope_key("abc", &kept);
    assert!(key.starts_with(&envelopes_of("abc")));
    assert!(!envelope_key("abcd", &kept).starts_with(&envelopes_of("abc")));
    assert_ne!(
        key,
        envelope_key(
            "abc",
            &Kept {
                version: 3,
                digest: [8; 32]
            }
        )
    );
}

#[test]
fn the_rate_limiters_in_wrangler_toml_are_the_ones_the_worker_counts_on() {
    let config: toml::Table = include_str!("../wrangler.toml").parse().unwrap();
    let limiters = config["ratelimits"].as_array().unwrap();
    for (name, limit) in [("READS", READS_IN_A_PERIOD), ("POLLS", POLLS_IN_A_PERIOD)] {
        let limiter = limiters
            .iter()
            .find(|one| one["name"].as_str() == Some(name))
            .unwrap();
        let simple = &limiter["simple"];
        assert_eq!(simple["limit"].as_integer(), Some(limit as i64), "{name}");
        assert_eq!(
            simple["period"].as_integer(),
            Some(LIMITER_PERIOD),
            "{name}"
        );
    }
}

#[test]
fn the_secret_is_read_from_hexadecimal_and_anything_else_is_refused() {
    let said = "00ff".repeat(16);
    let secret = secret_from_hex(&said).unwrap();
    assert_eq!((secret[0], secret[1]), (0x00, 0xff));
    assert_eq!(secret_from_hex(&said.to_uppercase()), Some(secret));

    assert_eq!(secret_from_hex(&said[1..]), None);
    assert_eq!(secret_from_hex(&format!("+f{}", &said[2..])), None);
    // Sixty-four bytes, but not sixty-four digits: refused, never cut in the middle of a letter.
    assert_eq!(secret_from_hex(&format!("ñ{}", &said[2..])), None);
}

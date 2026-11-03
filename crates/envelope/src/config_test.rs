use super::*;

fn read() -> Config {
    Config {
        title: Some("Guía".into()),
        tags: vec!["tisty".into()],
        lang: Some("pt-BR".into()),
        paper: Some("letter".into()),
        sheets: true,
        landscape: true,
        fields: vec![Field {
            key: "author".into(),
            values: vec!["Ana".into()],
        }],
    }
}

#[test]
fn what_tisty_reads_from_a_document_holds() {
    assert!(read().holds());
    assert!(Config::default().holds());
}

#[test]
fn a_config_that_says_more_than_tisty_writes_does_not_hold() {
    let lying_across = Config {
        sheets: false,
        ..read()
    };
    let odd_lang = Config {
        lang: Some("es_<b>".into()),
        ..read()
    };
    let odd_paper = Config {
        paper: Some("A4 ".into()),
        ..read()
    };
    let empty_title = Config {
        title: Some(String::new()),
        ..read()
    };
    let many_tags = Config {
        tags: vec!["a".into(); TAGS_AT_MOST + 1],
        ..read()
    };
    let long_value = Config {
        fields: vec![Field {
            key: "k".into(),
            values: vec!["v".repeat(VALUE_AT_MOST + 1)],
        }],
        ..read()
    };
    for one in [
        lying_across,
        odd_lang,
        odd_paper,
        empty_title,
        many_tags,
        long_value,
    ] {
        assert!(!one.holds(), "{one:?}");
    }
}

#[test]
fn trimming_keeps_only_what_holds_so_an_odd_front_matter_still_shares() {
    let odd = Config {
        title: Some(String::new()),
        tags: (0..TAGS_AT_MOST + 5)
            .map(|at| at.to_string())
            .chain([String::new()])
            .collect(),
        lang: Some("x".into()),
        paper: Some("Huge Paper".into()),
        sheets: false,
        landscape: true,
        fields: vec![
            Field {
                key: String::new(),
                values: vec![],
            },
            Field {
                key: "kept".into(),
                values: vec!["yes".into()],
            },
        ],
    };
    let trimmed = odd.trimmed();
    assert!(trimmed.holds());
    assert_eq!(trimmed.title, None);
    assert_eq!(trimmed.tags.len(), TAGS_AT_MOST);
    assert_eq!((trimmed.lang, trimmed.paper), (None, None));
    assert!(!trimmed.landscape);
    assert_eq!(
        trimmed.fields,
        vec![Field {
            key: "kept".into(),
            values: vec!["yes".into()]
        }]
    );
}

#[test]
fn a_field_a_later_tisty_adds_is_passed_over() {
    let said = r#"{"title":"Guía","sheets":true,"columns":3}"#;
    let config: Config = serde_json::from_str(said).unwrap();
    assert_eq!(config.title.as_deref(), Some("Guía"));
    assert!(config.sheets);
}

use std::cell::RefCell;
use std::collections::HashMap;

use crate::moderation::Report;
use crate::store::{Doc, Fault, Kept, Saved, Store};

/// The store for tests and for running the server on one machine; nothing survives it.
#[derive(Debug, Default)]
pub struct Memory {
    docs: RefCell<HashMap<String, Doc>>,
    envelopes: RefCell<HashMap<(String, Kept), Vec<u8>>>,
    counters: RefCell<HashMap<String, (u64, i64)>>,
    holds: RefCell<HashMap<String, i64>>,
    reports: RefCell<Vec<Report>>,
}

impl Memory {
    pub fn envelopes(&self) -> usize {
        self.envelopes.borrow().len()
    }

    /// Lets every envelope go while the versions naming them stay, as a store that lost them would.
    pub fn lose_envelopes(&self) {
        self.envelopes.borrow_mut().clear();
    }

    /// How many names, counters and marks it holds, to show what lapses.
    pub fn kept(&self) -> usize {
        self.counters.borrow().len() + self.holds.borrow().len() + self.reports.borrow().len()
    }
}

impl Store for Memory {
    async fn doc(&self, id: &str) -> Result<Option<Doc>, Fault> {
        Ok(self.docs.borrow().get(id).cloned())
    }

    async fn save(&self, doc: &Doc, revision: Option<u64>) -> Result<Saved, Fault> {
        let mut docs = self.docs.borrow_mut();
        if docs.get(&doc.id).map(|held| held.revision) != revision {
            return Ok(Saved::Raced);
        }
        docs.insert(doc.id.clone(), doc.clone());
        Ok(Saved::Done)
    }

    async fn forget(&self, id: &str) -> Result<(), Fault> {
        self.docs.borrow_mut().remove(id);
        self.envelopes.borrow_mut().retain(|(of, _), _| of != id);
        Ok(())
    }

    async fn envelope(&self, id: &str, kept: &Kept) -> Result<Option<Vec<u8>>, Fault> {
        Ok(self
            .envelopes
            .borrow()
            .get(&(id.to_owned(), *kept))
            .cloned())
    }

    async fn keep(&self, id: &str, kept: &Kept, bytes: Vec<u8>) -> Result<(), Fault> {
        self.envelopes
            .borrow_mut()
            .insert((id.to_owned(), *kept), bytes);
        Ok(())
    }

    async fn drop_envelope(&self, id: &str, kept: &Kept) -> Result<(), Fault> {
        self.envelopes.borrow_mut().remove(&(id.to_owned(), *kept));
        Ok(())
    }

    async fn ending(&self, now: i64, at_most: usize) -> Result<Vec<String>, Fault> {
        let mut ended: Vec<(i64, String)> = self
            .docs
            .borrow()
            .values()
            .filter(|doc| doc.ends < now)
            .map(|doc| (doc.ends, doc.id.clone()))
            .collect();
        ended.sort();
        Ok(ended.into_iter().take(at_most).map(|(_, id)| id).collect())
    }

    async fn count(&self, key: &str, by: u64, until: i64, now: i64) -> Result<u64, Fault> {
        let mut counters = self.counters.borrow_mut();
        let held = counters.entry(key.to_owned()).or_insert((0, until));
        if held.1 < now {
            *held = (0, until);
        }
        held.0 = held.0.saturating_add(by);
        Ok(held.0)
    }

    async fn hold(&self, key: &str, until: i64) -> Result<(), Fault> {
        self.holds.borrow_mut().insert(key.to_owned(), until);
        Ok(())
    }

    async fn mark(&self, key: &str, until: i64, now: i64) -> Result<bool, Fault> {
        let mut holds = self.holds.borrow_mut();
        if holds.get(key).is_some_and(|held| *held >= now) {
            return Ok(false);
        }
        holds.insert(key.to_owned(), until);
        Ok(true)
    }

    async fn held(&self, key: &str, now: i64) -> Result<Option<i64>, Fault> {
        Ok(self
            .holds
            .borrow()
            .get(key)
            .copied()
            .filter(|until| *until >= now))
    }

    async fn file(&self, report: &Report) -> Result<(), Fault> {
        self.reports.borrow_mut().push(report.clone());
        Ok(())
    }

    async fn reports(&self, id: &str, now: i64) -> Result<Vec<Report>, Fault> {
        Ok(self
            .reports
            .borrow()
            .iter()
            .filter(|report| report.id == id && report.until >= now)
            .cloned()
            .collect())
    }

    async fn lapse(&self, now: i64) -> Result<(), Fault> {
        self.counters
            .borrow_mut()
            .retain(|_, (_, until)| *until >= now);
        self.holds.borrow_mut().retain(|_, until| *until >= now);
        self.reports
            .borrow_mut()
            .retain(|report| report.until >= now);
        Ok(())
    }
}

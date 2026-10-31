//! What only Workers has: D1 and R2 behind the server's `Store`, its randomness, and the events it calls.

use std::net::IpAddr;

use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use tisty_share_proto::identity::Revocation;
use tisty_share_server::guard::{self, Act, Allowance};
use tisty_share_server::keys::{Randomness, Slowness};
use tisty_share_server::moderation::Report;
use tisty_share_server::share::{Policy, Share};
use tisty_share_server::store::{Doc, Fault, Kept, Saved, Store};
use worker::js_sys::{self, Function, Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{
    Bucket, Context, D1Database, D1PreparedStatement, Date, Env, Headers, RateLimiter, Request,
    Response, ScheduleContext, ScheduledEvent, event,
};

use crate::kept::{self, Body, Id, Until, Value};
use crate::{api, sql};

struct Cloud {
    db: D1Database,
    envelopes: Bucket,
    /// None where the binding is not there, and then D1 counts reads and polls as it counts the rest.
    reads: Option<RateLimiter>,
    polls: Option<RateLimiter>,
}

fn fault(error: impl std::fmt::Display) -> Fault {
    Fault(error.to_string())
}

/// D1 takes numbers as JavaScript does, which holds every count and second the server keeps.
fn number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn bound(statement: D1PreparedStatement, values: &[JsValue]) -> Result<D1PreparedStatement, Fault> {
    statement.bind(values).map_err(fault)
}

fn parsed<T: DeserializeOwned>(text: &str) -> Result<T, Fault> {
    serde_json::from_str(text).map_err(fault)
}

impl Cloud {
    async fn first<T: DeserializeOwned>(
        &self,
        query: &str,
        values: &[JsValue],
    ) -> Result<Option<T>, Fault> {
        bound(self.db.prepare(query), values)?
            .first(None)
            .await
            .map_err(fault)
    }

    async fn all<T: DeserializeOwned>(
        &self,
        query: &str,
        values: &[JsValue],
    ) -> Result<Vec<T>, Fault> {
        let done = bound(self.db.prepare(query), values)?
            .all()
            .await
            .map_err(fault)?;
        done.results().map_err(fault)
    }

    /// How many rows a statement wrote; D1 not saying is a fault, never a race lost.
    async fn changes(&self, query: &str, values: &[JsValue]) -> Result<usize, Fault> {
        let done = bound(self.db.prepare(query), values)?
            .run()
            .await
            .map_err(fault)?;
        done.meta()
            .map_err(fault)?
            .and_then(|meta| meta.changes)
            .ok_or_else(|| Fault("D1 did not say what it changed".into()))
    }
}

impl Store for Cloud {
    async fn doc(&self, id: &str) -> Result<Option<Doc>, Fault> {
        let held: Option<Body> = self.first(sql::DOC, &[id.into()]).await?;
        held.map(|held| parsed(&held.body)).transpose()
    }

    async fn save(&self, doc: &Doc, revision: Option<u64>) -> Result<Saved, Fault> {
        let body = serde_json::to_string(doc).map_err(fault)?;
        let mut values = vec![
            doc.id.as_str().into(),
            number(doc.revision as i64),
            number(doc.ends),
            body.into(),
        ];
        let query = match revision {
            None => sql::INSERT_DOC,
            Some(was) => {
                values.push(number(was as i64));
                sql::UPDATE_DOC
            }
        };
        Ok(match self.changes(query, &values).await? {
            0 => Saved::Raced,
            _ => Saved::Done,
        })
    }

    async fn forget(&self, id: &str) -> Result<(), Fault> {
        // The envelopes go first: a row left behind is swept again, an envelope without one never is.
        let listed = self
            .envelopes
            .list()
            .prefix(kept::envelopes_of(id))
            .execute()
            .await
            .map_err(fault)?;
        let keys: Vec<String> = listed.objects().iter().map(|object| object.key()).collect();
        if !keys.is_empty() {
            self.envelopes.delete_multiple(keys).await.map_err(fault)?;
        }
        self.changes(sql::FORGET, &[id.into()]).await?;
        Ok(())
    }

    async fn envelope(&self, id: &str, kept: &Kept) -> Result<Option<Vec<u8>>, Fault> {
        let Some(object) = self
            .envelopes
            .get(kept::envelope_key(id, kept))
            .execute()
            .await
            .map_err(fault)?
        else {
            return Ok(None);
        };
        let Some(body) = object.body() else {
            return Ok(None);
        };
        Ok(Some(body.bytes().await.map_err(fault)?))
    }

    async fn keep(&self, id: &str, kept: &Kept, bytes: Vec<u8>) -> Result<(), Fault> {
        self.envelopes
            .put(kept::envelope_key(id, kept), bytes)
            .execute()
            .await
            .map_err(fault)?;
        Ok(())
    }

    async fn drop_envelope(&self, id: &str, kept: &Kept) -> Result<(), Fault> {
        self.envelopes
            .delete(kept::envelope_key(id, kept))
            .await
            .map_err(fault)
    }

    async fn ending(&self, now: i64, at_most: usize) -> Result<Vec<String>, Fault> {
        let values = [number(now), number(at_most as i64)];
        let ids: Vec<Id> = self.all(sql::ENDING, &values).await?;
        Ok(ids.into_iter().map(|one| one.id).collect())
    }

    async fn count(&self, key: &str, by: u64, until: i64, now: i64) -> Result<u64, Fault> {
        let values = [key.into(), number(by as i64), number(until), number(now)];
        let counted: Option<Value> = self.first(sql::COUNT, &values).await?;
        counted
            .map(|counted| counted.value)
            .ok_or_else(|| Fault("a counter came back empty".into()))
    }

    async fn hold(&self, key: &str, until: i64) -> Result<(), Fault> {
        self.changes(sql::HOLD, &[key.into(), number(until)])
            .await?;
        Ok(())
    }

    async fn mark(&self, key: &str, until: i64, now: i64) -> Result<bool, Fault> {
        let values = [key.into(), number(until), number(now)];
        Ok(self.changes(sql::MARK, &values).await? > 0)
    }

    /// Reads and polls are the most of what callers do, so the binding counts them and D1 writes nothing.
    async fn within(
        &self,
        act: Act,
        who: &str,
        allowance: u64,
        now: i64,
    ) -> Result<Option<i64>, Fault> {
        let limiter = match act {
            Act::Read => self.reads.as_ref(),
            Act::Poll => self.polls.as_ref(),
            _ => None,
        };
        let Some(limiter) = limiter else {
            return guard::counted_within(self, act, who, allowance, now).await;
        };
        let outcome = limiter.limit(who.to_owned()).await.map_err(fault)?;
        Ok((!outcome.success).then_some(now + kept::LIMITER_PERIOD))
    }

    async fn held(&self, key: &str, now: i64) -> Result<Option<i64>, Fault> {
        let held: Option<Until> = self.first(sql::HELD, &[key.into(), number(now)]).await?;
        Ok(held.map(|held| held.until))
    }

    async fn file(&self, report: &Report) -> Result<(), Fault> {
        let body = serde_json::to_string(report).map_err(fault)?;
        let values = [report.id.as_str().into(), number(report.until), body.into()];
        self.changes(sql::FILE, &values).await?;
        Ok(())
    }

    async fn reports(&self, id: &str, now: i64) -> Result<Vec<Report>, Fault> {
        let held: Vec<Body> = self.all(sql::REPORTS, &[id.into(), number(now)]).await?;
        held.iter().map(|held| parsed(&held.body)).collect()
    }

    async fn revoke(&self, share: &str, root: &str, record: &Revocation) -> Result<(), Fault> {
        let body = serde_json::to_string(record).map_err(fault)?;
        let values = [share.into(), root.into(), body.into()];
        self.changes(sql::REVOKE, &values).await?;
        Ok(())
    }

    async fn revocation(&self, share: &str, root: &str) -> Result<Option<Revocation>, Fault> {
        let held: Option<Body> = self
            .first(sql::REVOCATION, &[share.into(), root.into()])
            .await?;
        held.map(|held| parsed(&held.body)).transpose()
    }

    async fn lapse(&self, now: i64) -> Result<(), Fault> {
        let statements = sql::LAPSE
            .iter()
            .map(|query| bound(self.db.prepare(*query), &[number(now)]))
            .collect::<Result<Vec<_>, Fault>>()?;
        self.db.batch(statements).await.map_err(fault)?;
        Ok(())
    }
}

/// The runtime's `crypto.getRandomValues`, reached without code of our own that is unsafe.
struct Crypto;

impl Randomness for Crypto {
    fn fill(&mut self, into: &mut [u8]) -> bool {
        drawn(into).is_ok()
    }
}

fn drawn(into: &mut [u8]) -> Result<(), JsValue> {
    let crypto = Reflect::get(&js_sys::global(), &"crypto".into())?;
    let draw: Function = Reflect::get(&crypto, &"getRandomValues".into())?.dyn_into()?;
    let array = Uint8Array::new_with_length(into.len() as u32);
    draw.call1(&crypto, &array)?;
    array.copy_to(into);
    Ok(())
}

fn share(env: &Env) -> worker::Result<Share<Cloud, Crypto>> {
    let cloud = Cloud {
        db: env.d1("DB")?,
        envelopes: env.bucket("ENVELOPES")?,
        reads: env.rate_limiter("READS").ok(),
        polls: env.rate_limiter("POLLS").ok(),
    };
    let secret = kept::secret_from_hex(&env.secret("SHARE_SECRET")?.to_string())
        .ok_or_else(|| worker::Error::from("SHARE_SECRET is not 64 hexadecimal digits"))?;
    let per_hour = (3_600 / kept::LIMITER_PERIOD) as u64;
    let policy = Policy {
        // Measured in V8: log_n 12 takes about 7 ms, too close to the free plan's 10 ms of CPU a request.
        slowness: Slowness { log_n: 11, r: 8 },
        // The binding's numbers by the hour, so D1 counts the same when the binding is missing.
        allowance: Allowance {
            reads: kept::READS_IN_A_PERIOD * per_hour,
            polls: kept::POLLS_IN_A_PERIOD * per_hour,
            ..Allowance::default()
        },
        ..Policy::default()
    };
    Ok(Share::new(cloud, Crypto, policy, secret))
}

fn now() -> i64 {
    (Date::now().as_millis() / 1000) as i64
}

/// The body, read only as far as `ceiling`, so one sent without its length cannot fill the Worker's memory.
async fn body_within(request: &mut Request, ceiling: u64) -> worker::Result<Option<Vec<u8>>> {
    if request.inner().body().is_none() {
        return Ok(Some(Vec::new()));
    }
    let mut stream = request.stream()?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk?);
        if body.len() as u64 > ceiling {
            return Ok(None);
        }
    }
    Ok(Some(body))
}

async fn served(mut request: Request, env: &Env) -> worker::Result<api::Answer> {
    let mut share = share(env)?;
    let headers = request.headers();
    // Cloudflare sets it on every request and a caller cannot, so the allowances rest on it.
    let caller: IpAddr = headers
        .get("CF-Connecting-IP")?
        .and_then(|ip| ip.parse().ok())
        .ok_or_else(|| worker::Error::from("the request came without its address"))?;
    let token = headers
        .get("Authorization")?
        .and_then(|said| said.strip_prefix("Bearer ").map(str::to_owned));
    let password = headers.get("Tisty-Password")?;
    let work = headers.get("Tisty-Work")?;
    let ceiling = api::ceiling(&share.policy.limits);
    let Some(body) = body_within(&mut request, ceiling).await? else {
        return Ok(api::oversized());
    };
    let asked = api::Asked {
        method: request.method().to_string(),
        path: request.path(),
        token,
        password,
        work,
        body,
        caller,
        now: now(),
    };
    Ok(api::answer(&mut share, asked).await)
}

fn answered(answer: api::Answer) -> worker::Result<Response> {
    if let Some(fault) = &answer.fault {
        worker::console_error!("{fault}");
    }
    let headers = Headers::new();
    for (name, value) in &answer.headers {
        headers.append(name, value)?;
    }
    // A 204 must carry no body at all, and an empty one still counts as one.
    let response = if answer.body.is_empty() {
        Response::empty()?
    } else {
        Response::from_bytes(answer.body)?
    };
    Ok(response.with_status(answer.status).with_headers(headers))
}

/// The tag this version was deployed with, if it has one; read loosely, since a version deployed by hand has none.
fn deployed_as(env: &Env) -> Option<String> {
    let metadata = Reflect::get(env, &"VERSION".into()).ok()?;
    let tag = Reflect::get(&metadata, &"tag".into()).ok()?.as_string()?;
    Some(tag).filter(|tag| !tag.is_empty())
}

#[event(fetch)]
async fn fetch(request: Request, env: Env, _: Context) -> worker::Result<Response> {
    let mut answer = served(request, &env)
        .await
        .unwrap_or_else(|why| api::broken(why.to_string()));
    // Said on every answer, so a deploy can tell its own version is the one answering.
    if let Some(tag) = deployed_as(&env) {
        answer.headers.push(("Tisty-Worker", tag));
    }
    answered(answer)
}

#[event(scheduled)]
async fn scheduled(_: ScheduledEvent, env: Env, _: ScheduleContext) {
    let share = match share(&env) {
        Ok(share) => share,
        Err(why) => return worker::console_error!("the sweep could not start: {why}"),
    };
    // Said here, a few times an hour, rather than on every request that falls back to D1.
    if share.store.reads.is_none() || share.store.polls.is_none() {
        worker::console_warn!("a rate limiter is missing, so D1 counts reads and polls");
    }
    let swept = match share.sweep(now()).await {
        Ok(swept) => swept,
        Err(why) => return worker::console_error!("the sweep failed: {why}"),
    };
    if swept.gone > 0 {
        worker::console_log!("the sweep took {} documents", swept.gone);
    }
    for (id, fault) in &swept.stuck {
        worker::console_error!("the sweep could not take {id}: {fault}");
    }
    if let Some(fault) = &swept.unlapsed {
        worker::console_error!("the sweep could not let old counters go: {fault}");
    }
}

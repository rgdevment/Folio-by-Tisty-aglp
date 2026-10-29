//! Tisty Share over HTTP: a request read into one of the server's steps, and the answer it gets.

use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tisty_share_proto::limits::Limits;
use tisty_share_proto::work::Proof;
use tisty_share_server::keys::Randomness;
use tisty_share_server::moderation::{Category, Complaint};
use tisty_share_server::share::{Ask, Manage, Refused, Share};
use tisty_share_server::store::Store;

/// Where the steps live, so the reading page can have the rest of the domain.
pub const ROOT: &str = "/api/v1/";

/// Room for an envelope's manifest, signature and tags beside what its limits let it carry.
const ENVELOPE_OVERHEAD: u64 = 64 * 1024;

/// Said on every answer: nothing private is cached or indexed (decision 63), and the browser keeps to HTTPS.
const ALWAYS: [(&str, &str); 6] = [
    ("Cache-Control", "no-store"),
    ("X-Robots-Tag", "noindex, nofollow"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Content-Type-Options", "nosniff"),
    (
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
    ),
    (
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
    ),
];

const ROBOTS: &str = "User-agent: *\nDisallow: /\n";

/// Where a person who lands on the domain itself, or on a page it does not have, is sent.
const HOME: &str = "https://www.tisty.app/";

/// What a step needs of a request, whatever carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub method: String,
    pub path: String,
    /// The edit or management token, from `Authorization: Bearer`.
    pub token: Option<String>,
    /// The reader's password, in `Tisty-Password` so it never sits in a URL or a log.
    pub password: Option<String>,
    /// The proof of work, as JSON in `Tisty-Work`.
    pub work: Option<String>,
    pub body: Vec<u8>,
    pub caller: IpAddr,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
    /// What failed in the store, for the host's log and never for the caller.
    pub fault: Option<String>,
}

/// Why a request gets no step, besides the server's own refusals.
enum Turned {
    Refused(Refused),
    Unreadable,
    Unknown,
}

impl From<Refused> for Turned {
    fn from(refused: Refused) -> Self {
        Turned::Refused(refused)
    }
}

#[derive(Deserialize)]
#[serde(tag = "for", rename_all = "snake_case", deny_unknown_fields)]
enum Asking {
    Reserve,
    /// The envelope's digest in base64url, and its size.
    Upload {
        id: String,
        digest: String,
        bytes: u64,
    },
    Report {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reporting {
    category: Category,
    detail: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Appealing {
    detail: String,
}

#[derive(Serialize)]
struct Links<'a> {
    id: &'a str,
    edit: &'a str,
    admin: &'a str,
}

/// Refuses a body too large to be any envelope, so a host need not read it to know.
pub fn too_large(limits: &Limits, length: u64) -> Option<Answer> {
    (length > ceiling(limits)).then(oversized)
}

/// The most a body may weigh: the largest envelope these limits let through.
pub fn ceiling(limits: &Limits) -> u64 {
    limits
        .text
        .saturating_add(limits.all_pictures)
        .saturating_add(ENVELOPE_OVERHEAD)
}

pub fn oversized() -> Answer {
    finished(said(413, json!({ "refused": "too_large" })))
}

/// What a host answers when it cannot even reach a step, said as every other answer is.
pub fn broken(why: String) -> Answer {
    let mut answer = finished(said(500, json!({ "refused": "unready" })));
    answer.fault = Some(why);
    answer
}

/// A step's answer; the host has already held the body to `ceiling`, as it alone can before reading it.
pub async fn answer<S: Store, R: Randomness>(share: &mut Share<S, R>, asked: Asked) -> Answer {
    let now = asked.now;
    let answer = match routed(share, asked).await {
        Ok(answer) => answer,
        Err(Turned::Refused(refused)) => refusal(&refused, now),
        Err(Turned::Unreadable) => said(400, json!({ "refused": "unreadable" })),
        Err(Turned::Unknown) => said(404, json!({ "refused": "unknown" })),
    };
    finished(answer)
}

async fn routed<S: Store, R: Randomness>(
    share: &mut Share<S, R>,
    asked: Asked,
) -> Result<Answer, Turned> {
    if asked.method == "GET" && asked.path == "/robots.txt" {
        return Ok(plain(200, "text/plain; charset=utf-8", ROBOTS.into()));
    }
    let Some(rest) = asked.path.strip_prefix(ROOT) else {
        return elsewhere(&asked);
    };
    let parts: Vec<&str> = rest.split('/').collect();
    let (caller, now) = (asked.caller, asked.now);
    let token = asked.token.as_deref();
    match (asked.method.as_str(), parts.as_slice()) {
        ("GET", ["limits"]) => Ok(said(200, json!(share.policy.limits))),
        ("POST", ["challenge"]) => {
            let asking: Asking = read(&asked.body)?;
            let challenge = match &asking {
                Asking::Reserve => share.challenge(Ask::Reserve, now)?,
                Asking::Upload { id, digest, bytes } => {
                    let digest = digest_of(digest).ok_or(Turned::Unreadable)?;
                    let bytes = *bytes;
                    share.challenge(Ask::Upload { id, digest, bytes }, now)?
                }
                Asking::Report { id } => share.challenge(Ask::Report { id }, now)?,
            };
            Ok(said(200, json!(challenge)))
        }
        ("POST", ["docs"]) => {
            let proof = proof(asked.work.as_deref())?;
            let reserved = share.reserve(caller, &proof, now).await?;
            let links = Links {
                id: &reserved.id,
                edit: &reserved.edit,
                admin: &reserved.admin,
            };
            Ok(said(201, json!(links)))
        }
        ("PUT", ["docs", id]) => {
            let proof = proof(asked.work.as_deref())?;
            let edit = token.ok_or(Refused::Forbidden)?;
            let version = share
                .upload(id, edit, asked.body, caller, &proof, now)
                .await?;
            Ok(said(200, json!({ "version": version })))
        }
        ("GET", ["docs", id]) => {
            let served = share
                .read(id, asked.password.as_deref(), caller, now)
                .await?;
            Ok(envelope(served.version, served.envelope))
        }
        ("GET", ["docs", id, "latest"]) => {
            let latest = share.latest(id, caller, now).await?;
            Ok(said(200, json!({ "latest": latest })))
        }
        ("GET", ["docs", id, "versions", version]) => {
            let version = version.parse().map_err(|_| Turned::Unknown)?;
            let token = token.ok_or(Refused::Forbidden)?;
            let served = share.version(id, token, version, now).await?;
            Ok(envelope(served.version, served.envelope))
        }
        ("GET", ["docs", id, "info"]) => {
            let admin = token.ok_or(Refused::Forbidden)?;
            Ok(said(200, json!(share.info(id, admin, now).await?)))
        }
        ("POST", ["docs", id, "manage"]) => {
            let admin = token.ok_or(Refused::Forbidden)?;
            let what: Manage = read(&asked.body)?;
            share.manage(id, admin, what, now).await?;
            Ok(plain(204, "text/plain", Vec::new()))
        }
        ("POST", ["docs", id, "reports"]) => {
            let proof = proof(asked.work.as_deref())?;
            let reporting: Reporting = read(&asked.body)?;
            // The link a reporter may hand over waits for the operator's key of stage 5 (decision 42).
            let complaint = Complaint {
                category: reporting.category,
                detail: reporting.detail,
                link: None,
            };
            share.report(id, complaint, caller, &proof, now).await?;
            Ok(plain(204, "text/plain", Vec::new()))
        }
        ("POST", ["docs", id, "appeal"]) => {
            let admin = token.ok_or(Refused::Forbidden)?;
            let appealing: Appealing = read(&asked.body)?;
            share.appeal(id, admin, &appealing.detail, now).await?;
            Ok(plain(204, "text/plain", Vec::new()))
        }
        _ => Err(Turned::Unknown),
    }
}

/// A page outside the API goes home: for good from the root, for now elsewhere, since the reading page will take those paths.
fn elsewhere(asked: &Asked) -> Result<Answer, Turned> {
    if asked.method != "GET" && asked.method != "HEAD" {
        return Err(Turned::Unknown);
    }
    let status = if asked.path == "/" { 301 } else { 302 };
    let mut answer = plain(status, "text/plain", Vec::new());
    answer.headers.push(("Location", HOME.to_owned()));
    Ok(answer)
}

/// Each refusal as a status and a word Tisty and the web turn into the reader's language.
fn refusal(refused: &Refused, now: i64) -> Answer {
    let (status, word) = match refused {
        Refused::Missing => (404, "missing"),
        Refused::Gone => (410, "gone"),
        Refused::Paused => (423, "paused"),
        Refused::Blocked => (451, "blocked"),
        Refused::Forbidden => (403, "forbidden"),
        Refused::PasswordAsked => (401, "password_asked"),
        Refused::PasswordWrong => (401, "password_wrong"),
        Refused::PasswordLocked { .. } => (429, "password_locked"),
        Refused::Behind { .. } => (409, "behind"),
        Refused::Misaddressed => (422, "misaddressed"),
        Refused::Envelope(_) => (422, "envelope"),
        Refused::Unsigned => (422, "unsigned"),
        Refused::WorkRefused => (403, "work_refused"),
        Refused::Slow { .. } => (429, "slow"),
        Refused::Reported => (409, "reported"),
        Refused::TooLong => (413, "too_long"),
        Refused::Crowded => (503, "crowded"),
        Refused::NoRandomness => (500, "no_randomness"),
        Refused::Store(_) => (500, "store"),
    };
    let mut body = json!({ "refused": word });
    let mut answer = match refused {
        Refused::Slow { until } | Refused::PasswordLocked { until } => {
            body["until"] = json!(until);
            let mut answer = said(status, body);
            let wait = (until - now).max(1);
            answer.headers.push(("Retry-After", wait.to_string()));
            answer
        }
        Refused::Behind { latest } => {
            body["latest"] = json!(latest);
            said(status, body)
        }
        Refused::Envelope(why) => {
            body["why"] = json!(why.to_string());
            said(status, body)
        }
        _ => said(status, body),
    };
    if status == 401 {
        answer
            .headers
            .push(("WWW-Authenticate", "Tisty-Password".into()));
    }
    if let Refused::Store(fault) = refused {
        answer.fault = Some(fault.to_string());
    }
    answer
}

fn read<T: DeserializeOwned>(body: &[u8]) -> Result<T, Turned> {
    serde_json::from_slice(body).map_err(|_| Turned::Unreadable)
}

fn proof(work: Option<&str>) -> Result<Proof, Turned> {
    let work = work.ok_or(Refused::WorkRefused)?;
    serde_json::from_str(work).map_err(|_| Turned::Unreadable)
}

fn digest_of(said: &str) -> Option<[u8; 32]> {
    <[u8; 32]>::try_from(URL_SAFE_NO_PAD.decode(said).ok()?.as_slice()).ok()
}

fn said(status: u16, body: serde_json::Value) -> Answer {
    plain(status, "application/json", body.to_string().into_bytes())
}

fn envelope(version: u64, bytes: Vec<u8>) -> Answer {
    let mut answer = plain(200, "application/octet-stream", bytes);
    answer.headers.push(("Tisty-Version", version.to_string()));
    answer
}

fn plain(status: u16, kind: &str, body: Vec<u8>) -> Answer {
    Answer {
        status,
        headers: vec![("Content-Type", kind.to_owned())],
        body,
        fault: None,
    }
}

fn finished(mut answer: Answer) -> Answer {
    answer.headers.extend(
        ALWAYS
            .iter()
            .map(|(name, value)| (*name, (*value).to_owned())),
    );
    answer
}

#[cfg(test)]
#[path = "api_test.rs"]
mod tests;

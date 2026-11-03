//! Tisty Share over HTTP: a request read into one of the server's steps, and the answer it gets.

use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tisty_share_proto::identity::Revocation;
use tisty_share_proto::limits::Limits;
use tisty_share_proto::work::Proof;
use tisty_share_server::keys::Randomness;
use tisty_share_server::moderation::{Category, Complaint};
use tisty_share_server::share::{Ask, Manage, Refused, Seen, Served, Share};
use tisty_share_server::store::Store;

/// Where the steps live, so the reading page can have the rest of the domain.
pub const ROOT: &str = "/api/v1/";

/// Room for the manifest (16 KB), both signatures (4 KB), what it cites (64 KB) and the tags of the words and the page.
const ENVELOPE_OVERHEAD: u64 = 96 * 1024;
/// What each picture adds beside its bytes: its tag, its hash in the index and its hash in the writer's signature.
const PICTURE_OVERHEAD: u64 = 16 + 32 + 48;

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

/// What a step needs of a request, whatever carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub method: String,
    pub path: String,
    /// The edit or management token, from `Authorization: Bearer`.
    pub token: Option<String>,
    /// The reader's password as its UTF-8 in base64url, in `Tisty-Password` so it never sits in a URL or a log.
    pub password: Option<String>,
    /// The proof of work, as JSON in `Tisty-Work`.
    pub work: Option<String>,
    pub sheet: bool,
    pub rest: Option<String>,
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
    Password {
        id: String,
    },
    Reader {
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
        .saturating_add(limits.html)
        .saturating_add(limits.all_pictures)
        .saturating_add(limits.pictures.saturating_mul(PICTURE_OVERHEAD))
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

/// A step's answer with what a read leaves written down first, for a host that cannot wait past its answer.
pub async fn answer<S: Store, R: Randomness>(share: &mut Share<S, R>, asked: Asked) -> Answer {
    let (mut answer, seen) = answer_first(share, asked).await;
    if let Some(seen) = seen {
        answer.fault = noted(share, seen).await;
    }
    answer
}

/// Writes down what a read left, saying what failed for the host's log; the reader already has their answer.
pub async fn noted<S: Store, R: Randomness>(share: &Share<S, R>, seen: Seen) -> Option<String> {
    share
        .seen(seen)
        .await
        .err()
        .map(|refused| format!("a read could not be written down: {refused}"))
}

/// A step's answer and what a read leaves to write down after it; the host has already held the body to `ceiling`.
pub async fn answer_first<S: Store, R: Randomness>(
    share: &mut Share<S, R>,
    asked: Asked,
) -> (Answer, Option<Seen>) {
    let now = asked.now;
    let mut seen = None;
    let answer = match routed(share, asked, &mut seen).await {
        Ok(answer) => answer,
        Err(Turned::Refused(refused)) => refusal(&refused, now),
        Err(Turned::Unreadable) => said(400, json!({ "refused": "unreadable" })),
        Err(Turned::Unknown) => said(404, json!({ "refused": "unknown" })),
    };
    (finished(answer), seen)
}

async fn routed<S: Store, R: Randomness>(
    share: &mut Share<S, R>,
    asked: Asked,
    seen: &mut Option<Seen>,
) -> Result<Answer, Turned> {
    // Only the API reaches the Worker; the home page, the lost page and robots are the reading page's own files.
    let rest = asked.path.strip_prefix(ROOT).ok_or(Turned::Unknown)?;
    let parts: Vec<&str> = rest.split('/').collect();
    let (caller, now) = (asked.caller, asked.now);
    let token = asked.token.as_deref();
    match (asked.method.as_str(), parts.as_slice()) {
        ("GET", ["limits"]) => Ok(said(200, json!(share.policy.limits))),
        ("POST", ["challenge"]) => {
            let asking: Asking = read(&asked.body)?;
            let challenge = match &asking {
                Asking::Reserve => share.challenge(Ask::Reserve, caller, now).await?,
                Asking::Upload { id, digest, bytes } => {
                    let digest = digest_of(digest).ok_or(Turned::Unreadable)?;
                    let bytes = *bytes;
                    share
                        .challenge(Ask::Upload { id, digest, bytes }, caller, now)
                        .await?
                }
                Asking::Report { id } => share.challenge(Ask::Report { id }, caller, now).await?,
                Asking::Password { id } => {
                    share.challenge(Ask::Password { id }, caller, now).await?
                }
                Asking::Reader { id } => share.challenge(Ask::Reader { id }, caller, now).await?,
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
            let password = asked.password.as_deref().map(password_of).transpose()?;
            // Work matters only once a document asked for it, so a header that is no proof is read as none.
            let proof = asked
                .work
                .as_deref()
                .and_then(|work| serde_json::from_str::<Proof>(work).ok());
            let (served, left) = share
                .read(
                    id,
                    password.as_deref(),
                    proof.as_ref(),
                    asked.sheet,
                    caller,
                    now,
                )
                .await?;
            *seen = Some(left);
            Ok(envelope(served))
        }
        ("GET", ["docs", id, "rest"]) => {
            let ticket = asked.rest.as_deref().ok_or(Refused::Forbidden)?;
            let rest = share.rest(id, ticket, caller, now).await?;
            Ok(plain(200, "application/octet-stream", rest))
        }
        ("GET", ["docs", id, "latest"]) => {
            let latest = share.latest(id, token, caller, now).await?;
            Ok(said(200, json!({ "latest": latest })))
        }
        ("GET", ["docs", id, "versions", version]) => {
            let version = version.parse().map_err(|_| Turned::Unknown)?;
            let token = token.ok_or(Refused::Forbidden)?;
            let served = share.version(id, token, version, now).await?;
            Ok(envelope(served))
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
        ("POST", ["revocations"]) => {
            let revocations: Vec<Revocation> = read(&asked.body)?;
            share.revoke(&revocations, caller, now).await?;
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

/// Each refusal as a status and a word Tisty and the web turn into the reader's language.
fn refusal(refused: &Refused, now: i64) -> Answer {
    let (status, word) = match refused {
        Refused::Missing => (404, "missing"),
        Refused::Gone => (410, "gone"),
        Refused::CitedGone => (404, "cited_gone"),
        Refused::Unwritten => (404, "unwritten"),
        Refused::Paused => (423, "paused"),
        Refused::Blocked => (451, "blocked"),
        Refused::Forbidden => (403, "forbidden"),
        Refused::PasswordAsked => (401, "password_asked"),
        Refused::PasswordWrong => (401, "password_wrong"),
        Refused::PasswordLocked { .. } => (429, "password_locked"),
        Refused::WorkAsked => (428, "work_asked"),
        Refused::Behind { .. } => (409, "behind"),
        Refused::Misaddressed => (422, "misaddressed"),
        Refused::Envelope(_) => (422, "envelope"),
        Refused::Unsigned => (422, "unsigned"),
        Refused::WorkRefused => (403, "work_refused"),
        Refused::Slow { .. } => (429, "slow"),
        Refused::Reported => (409, "reported"),
        Refused::TooLong => (413, "too_long"),
        Refused::SharesFull => (409, "shares_full"),
        Refused::PicturesFull => (413, "pictures_full"),
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

// A header carries only Latin-1, so a password in any language travels as its UTF-8.
fn password_of(said: &str) -> Result<String, Turned> {
    let bytes = URL_SAFE_NO_PAD
        .decode(said)
        .map_err(|_| Turned::Unreadable)?;
    String::from_utf8(bytes).map_err(|_| Turned::Unreadable)
}

fn digest_of(said: &str) -> Option<[u8; 32]> {
    <[u8; 32]>::try_from(URL_SAFE_NO_PAD.decode(said).ok()?.as_slice()).ok()
}

fn said(status: u16, body: serde_json::Value) -> Answer {
    plain(status, "application/json", body.to_string().into_bytes())
}

/// The envelope, with what the reading page shows around it in headers, so the body stays the sealed bytes alone.
fn envelope(served: Served) -> Answer {
    let facts = served.facts;
    let mut answer = plain(200, "application/octet-stream", served.envelope);
    answer
        .headers
        .push(("Tisty-Version", served.version.to_string()));
    answer
        .headers
        .push(("Tisty-Shared", facts.shared.to_string()));
    if let Some(written) = facts.written {
        answer.headers.push(("Tisty-Written", written.to_string()));
    }
    answer.headers.push(("Tisty-Ends", facts.ends.to_string()));
    if facts.gated {
        answer.headers.push(("Tisty-Gated", "1".into()));
    }
    // Each one is the root's own signed word, so the page checks it rather than taking the server's.
    if !served.revoked.is_empty() {
        answer
            .headers
            .push(("Tisty-Revoked", json!(served.revoked).to_string()));
    }
    if let Some(ticket) = served.rest {
        answer.headers.push(("Tisty-Rest", ticket));
    }
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

/// The line a read served leaves in the logs: the link's id, never its key, and where it was read from, never who.
pub fn read_line(path: &str, country: Option<&str>, colo: &str) -> Option<String> {
    let id = path.strip_prefix(ROOT)?.strip_prefix("docs/")?;
    (!id.is_empty() && !id.contains('/'))
        .then(|| json!({ "read": id, "country": country, "colo": colo }).to_string())
}

/// Where a request waited, in tens of milliseconds; only a read served says on what, so no refusal tells its branch.
pub fn timing(waited: Option<[u64; 2]>, total: u64) -> String {
    let tens = |ms: u64| ms.div_ceil(10) * 10;
    match waited {
        Some([on_d1, on_r2]) => format!(
            "d1;dur={}, r2;dur={}, total;dur={}",
            tens(on_d1),
            tens(on_r2),
            tens(total)
        ),
        None => format!("total;dur={}", tens(total)),
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

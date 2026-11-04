import { type AdminAction, administer } from "../core/admin";
import { dayOf } from "../core/limits";
import { netDigest } from "../core/net";
import { type Asked, readDoc } from "../core/read";
import { type Refused, tooFast } from "../core/refused";
import { type ReportTools, reportDoc, saidOf } from "../core/report";
import { startNow } from "../core/start";

const PREFIX = "/api/v1/";
const DOC_PATH = /^docs\/([A-Za-z0-9]{8})(?:\/(report|admin|pause|resume|appeal))?$/;
const REPORT_BYTES_AT_MOST = 16 * 1024;

export const STATUS: Record<Refused["refused"], number> = {
  missing: 404,
  paused: 403,
  blocked: 403,
  slow: 429,
  quota: 429,
  proof: 429,
  bad_report: 400,
  too_big: 413,
  not_blocked: 409,
  appealed: 409,
};

const ADMIN_ROUTES: Record<string, AdminAction> = {
  "GET admin": "status",
  "POST pause": "pause",
  "POST resume": "resume",
  "POST appeal": "appeal",
  "DELETE ": "stop",
};

const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const json = (status: number, said: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(said), {
    status,
    headers: { ...API_HEADERS, "Content-Type": "application/json", ...headers },
  });

const refusal = (refused: Refused, now: number): Response => {
  const waits = "until" in refused ? { "Retry-After": String(Math.ceil((refused.until - now) / 1000)) } : undefined;
  return json(STATUS[refused.refused], refused, waits);
};

const ipOf = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "";

const cfOf = (request: Request) => (request as { cf?: { country?: string; colo?: string; asn?: number } }).cf;

export interface Api {
  tools: ReportTools;
  waitUntil: (work: Promise<unknown>) => void;
  now: number;
}

const answerRead = async (request: Request, id: string, { tools, waitUntil, now }: Api): Promise<Response> => {
  const proof = request.headers.get("Folio-Proof");
  const asked: Asked = { id, now, ip: ipOf(request), ...(proof === null ? {} : { proof }) };
  const answer = await readDoc(asked, tools);
  if (!("served" in answer)) return refusal(answer, now);

  const cf = cfOf(request);
  // What the read log keeps (decision 98): the document, the country and the data center, never the network.
  console.log(JSON.stringify({ read: id, country: cf?.country, colo: cf?.colo }));
  const { note } = answer;
  if (note) waitUntil(tools.store.note(note, dayOf(now)));
  return new Response(answer.body, {
    headers: {
      ...API_HEADERS,
      "Content-Type": "application/octet-stream",
      "Folio-Version": String(answer.version.n),
      "Folio-Hash": answer.version.hash,
      "Folio-Arrived": String(answer.version.at),
      "Folio-Dies-On": String(answer.diesOn),
    },
  });
};

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Read in pieces, since a body sent in parts says no length and could be any size.
const textUpTo = async (request: Request, atMost: number): Promise<string | null> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(pieces).text();
    bytes += value.byteLength;
    if (bytes > atMost) {
      await reader.cancel();
      return null;
    }
    pieces.push(value);
  }
};

const answerReport = async (request: Request, id: string, { tools, now }: Api): Promise<Response> => {
  const text = await textUpTo(request, REPORT_BYTES_AT_MOST);
  if (text === null) return refusal({ refused: "too_big" }, now);
  const said = saidOf(jsonOf(text), tools.limits);
  if (!said) return refusal({ refused: "bad_report" }, now);

  const proof = request.headers.get("Folio-Proof");
  const answer = await reportDoc(
    { id, now, said, ip: ipOf(request), asn: cfOf(request)?.asn ?? 0, ...(proof === null ? {} : { proof }) },
    tools,
  );
  return "refused" in answer ? refusal(answer, now) : json(202, answer);
};

const answerAdmin = async (
  request: Request,
  id: string,
  action: AdminAction,
  { tools, now }: Api,
): Promise<Response> => {
  const token = request.headers.get("Folio-Admin") ?? "";
  const answer = await administer({ id, now, action, token, ip: ipOf(request) }, tools);
  return "refused" in answer ? refusal(answer, now) : json(200, answer);
};

const answerStart = async (request: Request, { tools, now }: Api): Promise<Response> => {
  const net = await netDigest(await tools.dayKey(dayOf(now)), ipOf(request));
  // The brake and not a count: a start keeps nothing, so it should not write a row either.
  if (!(await tools.limiter.allows(net))) return refusal(tooFast(now), now);
  return json(200, await startNow(tools.secret, now));
};

export const answer = async (request: Request, api: Api): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
  const path = pathname.slice(PREFIX.length);

  if (path === "start" && request.method === "POST") return answerStart(request, api);
  const [, id, part = ""] = DOC_PATH.exec(path) ?? [];
  if (!id) return json(404, { refused: "missing" });

  const route = `${request.method} ${part}`;
  if (route === "GET ") return answerRead(request, id, api);
  if (route === "POST report") return answerReport(request, id, api);
  const action = ADMIN_ROUTES[route];
  return action ? answerAdmin(request, id, action, api) : json(404, { refused: "missing" });
};

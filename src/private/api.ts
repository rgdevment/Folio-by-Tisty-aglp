import { dayOf } from "../core/limits";
import { type Asked, type ReadTools, type Refused, readDoc } from "../core/read";
import { startNow } from "../core/start";

const PREFIX = "/api/v1/";
const DOC_PATH = /^docs\/([A-Za-z0-9]{8})$/;

const STATUS: Record<Refused["refused"], number> = {
  missing: 404,
  paused: 403,
  blocked: 403,
  slow: 429,
  proof: 429,
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

export interface Api {
  tools: ReadTools;
  waitUntil: (work: Promise<unknown>) => void;
  now: number;
}

const answerRead = async (request: Request, id: string, { tools, waitUntil, now }: Api): Promise<Response> => {
  const asked: Asked = {
    id,
    now,
    ip: request.headers.get("CF-Connecting-IP") ?? "",
    ...optional("proof", request.headers.get("Folio-Proof")),
  };
  const answer = await readDoc(asked, tools);
  if (!("served" in answer)) return refusal(answer, now);

  const cf = (request as { cf?: { country?: string; colo?: string } }).cf;
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

const optional = <K extends string>(key: K, value: string | null): { [P in K]?: string } =>
  value === null ? {} : ({ [key]: value } as { [P in K]: string });

export const answer = async (request: Request, api: Api): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
  const path = pathname.slice(PREFIX.length);

  if (path === "start" && request.method === "POST") return json(200, await startNow(api.tools.secret, api.now));
  const doc = DOC_PATH.exec(path);
  if (doc?.[1] && request.method === "GET") return answerRead(request, doc[1], api);
  return json(404, { refused: "missing" });
};

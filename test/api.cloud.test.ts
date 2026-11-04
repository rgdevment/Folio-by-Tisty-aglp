import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { load } from "js-yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import written from "../docs/openapi.yaml?raw";
import { Cloud } from "../src/cloudflare/store";
import { dayOf, GRAVE_REPORTS, LEVEL_ONE } from "../src/core/limits";
import { proofHolds, tokenHash } from "../src/core/start";
import { STATUS } from "../src/private/api";
import worker from "../src/private/index";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const TODAY = dayOf(Date.now());
const ID = "AbCdEfGh";
const TOKEN = "the admin token";

// biome-ignore lint/suspicious/noExplicitAny: the shape of an OpenAPI file is what this test looks through.
type Written = any;
const spec = load(written) as Written;

const resolved = (node: Written): Written => {
  if (!node?.$ref) return node;
  return (node.$ref as string)
    .slice(2)
    .split("/")
    .reduce((at, key) => at[key], spec);
};

const refusalsIn = (schema: Written): string[] => {
  const plain = resolved(schema);
  if (plain.oneOf) return plain.oneOf.flatMap(refusalsIn);
  const refused = plain.properties?.refused;
  if (!refused) return [];
  return refused.const ? [refused.const] : refused.enum;
};

const documented = (method: string, path: string, status: number): Written =>
  resolved(spec.paths[path]?.[method.toLowerCase()]?.responses?.[status]);

// The body against its schema: what it requires is there, nothing else is, and fixed values are those values.
const fits = (body: Written, schema: Written): boolean => {
  const plain = resolved(schema);
  if (plain.oneOf) return plain.oneOf.some((one: Written) => fits(body, one));
  const known = plain.properties ?? {};
  return (
    (plain.required ?? []).every((key: string) => key in body) &&
    Object.keys(body).every((key) => key in known && (!("const" in known[key]) || known[key].const === body[key]))
  );
};

interface Scenario {
  method: string;
  path: string;
  status: number;
  refused?: string;
  admin?: string;
  body?: string;
  braked?: boolean;
  broken?: boolean;
  ready?: () => Promise<unknown>;
  solves?: boolean;
  times?: number;
}

const send = async ({ method, path, admin, body, braked, broken }: Scenario, proof?: string, ip?: string) => {
  const context = createExecutionContext();
  const headers = new Headers({ "CF-Connecting-IP": ip ?? "198.51.100.77" });
  if (admin) headers.set("Folio-Admin", admin);
  if (proof) headers.set("Folio-Proof", proof);
  const limit = async () => {
    if (broken) throw new Error("broken on purpose");
    return { success: !braked };
  };
  const url = `https://tisty.cl/api/v1${path.replace("{id}", ID)}`;
  const response = await worker.fetch(
    new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...testEnv, FOLIO_SECRET: "09".repeat(32), ALERT_URL: "https://alerts.example/folio", READS: { limit } } as never,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

const share = async () => {
  await store.create(
    { id: ID, owner: "o1", editHash: "e", adminHash: await tokenHash(TOKEN), ttlDays: 3, net: "n" },
    TODAY,
  );
  await store.upload({ id: ID, n: 1, hash: "h1", body: "sealed", net: "n", at: 1234 }, TODAY);
};

const block = async () => {
  await share();
  await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ? WHERE id = '${ID}'`).bind(TODAY).run();
};

const pause = async () => {
  await share();
  await store.pause(ID, TODAY);
};

const pastTheFreeReaders = async () => {
  await share();
  await testEnv.DB.prepare(
    `CREATE TABLE seen_${TODAY} (owner TEXT, reader TEXT, doc TEXT, hour INTEGER, PRIMARY KEY (owner, reader, doc)) WITHOUT ROWID`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO seen_${TODAY} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     SELECT 'o1', 'r' || i, '${ID}', 9 FROM n`,
  )
    .bind(LEVEL_ONE.newReadersFree)
    .run();
};

const REPORT = JSON.stringify({ category: "phishing" });
const REPORT_PATH = "/docs/{id}/report";
const APPEAL_PATH = "/docs/{id}/appeal";

const adminRoute = (method: string, path: string, blockable = true): Scenario[] => [
  { method, path, status: 200, admin: TOKEN, ready: share },
  ...(blockable ? [{ method, path, status: 403, refused: "blocked", admin: TOKEN, ready: block }] : []),
  { method, path, status: 404, refused: "missing", admin: "wrong", ready: share },
  { method, path, status: 429, refused: "slow", admin: TOKEN, braked: true },
  { method, path, status: 500, refused: "failed", admin: TOKEN, broken: true },
];

const SCENARIOS: Scenario[] = [
  { method: "POST", path: "/start", status: 200 },
  { method: "POST", path: "/start", status: 429, refused: "slow", braked: true },
  { method: "POST", path: "/start", status: 500, refused: "failed", broken: true },
  { method: "GET", path: "/docs/{id}", status: 200, ready: share },
  { method: "GET", path: "/docs/{id}", status: 403, refused: "blocked", ready: block },
  { method: "GET", path: "/docs/{id}", status: 403, refused: "paused", ready: pause },
  { method: "GET", path: "/docs/{id}", status: 404, refused: "missing" },
  { method: "GET", path: "/docs/{id}", status: 429, refused: "slow", braked: true },
  { method: "GET", path: "/docs/{id}", status: 429, refused: "proof", ready: pastTheFreeReaders },
  { method: "GET", path: "/docs/{id}", status: 500, refused: "failed", broken: true },
  ...adminRoute("DELETE", "/docs/{id}"),
  { method: "POST", path: REPORT_PATH, status: 202, body: REPORT, solves: true, ready: share },
  { method: "POST", path: REPORT_PATH, status: 400, refused: "bad_report", body: "{}" },
  { method: "POST", path: REPORT_PATH, status: 413, refused: "too_big", body: "x".repeat(20_000) },
  { method: "POST", path: REPORT_PATH, status: 429, refused: "proof", body: REPORT },
  {
    method: "POST",
    path: REPORT_PATH,
    status: 429,
    refused: "quota",
    body: REPORT,
    solves: true,
    times: LEVEL_ONE.reportsAnHour + 1,
    ready: share,
  },
  {
    method: "POST",
    path: REPORT_PATH,
    status: 500,
    refused: "failed",
    body: JSON.stringify({ category: "csam" }),
    solves: true,
    ready: async () => {
      await share();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    },
  },
  ...adminRoute("GET", "/docs/{id}/admin", false),
  ...adminRoute("POST", "/docs/{id}/pause"),
  ...adminRoute("POST", "/docs/{id}/resume"),
  { method: "POST", path: APPEAL_PATH, status: 200, admin: TOKEN, ready: block },
  { method: "POST", path: APPEAL_PATH, status: 404, refused: "missing", admin: "wrong", ready: block },
  { method: "POST", path: APPEAL_PATH, status: 409, refused: "not_blocked", admin: TOKEN, ready: share },
  {
    method: "POST",
    path: APPEAL_PATH,
    status: 409,
    refused: "appealed",
    admin: TOKEN,
    ready: async () => {
      await block();
      await send({ method: "POST", path: APPEAL_PATH, status: 200, admin: TOKEN });
    },
  },
  { method: "POST", path: APPEAL_PATH, status: 429, refused: "slow", admin: TOKEN, braked: true },
  { method: "POST", path: APPEAL_PATH, status: 500, refused: "failed", admin: TOKEN, broken: true },
];

const operations = (): [string, string, Written][] =>
  Object.entries(spec.paths as Written).flatMap(([path, item]) =>
    Object.entries(item as Written)
      .filter(([method]) => method !== "parameters")
      .map(([method, operation]): [string, string, Written] => [method.toUpperCase(), path, operation]),
  );

const writtenAnswers = (): string[] =>
  operations().flatMap(([method, path, operation]) =>
    Object.keys(operation.responses).map((status) => `${method} ${path} ${status}`),
  );

const writtenRefusals = (): string[] =>
  operations().flatMap(([method, path, operation]) =>
    Object.entries(operation.responses as Written).flatMap(([status, response]) => {
      const schema = resolved(response).content?.["application/json"]?.schema;
      return schema ? refusalsIn(schema).map((refused) => `${method} ${path} ${status} ${refused}`) : [];
    }),
  );

const solve = async (salt: string, bits: number): Promise<string> => {
  for (let nonce = 0; ; nonce += 1) {
    if (await proofHolds(salt, String(nonce), bits)) return String(nonce);
  }
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  for (const table of ["docs", "net_day", "net_hour", "reports", "holds"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'seen_[0-9]*'").all<{
    name: string;
  }>();
  for (const { name } of tables.results) await testEnv.DB.prepare(`DROP TABLE ${name}`).run();
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("the written API", () => {
  it("has a scenario here for every answer it promises, and the other way around", () => {
    const tried = SCENARIOS.map(({ method, path, status }) => `${method} ${path} ${status}`);
    expect(new Set(tried)).toEqual(new Set(writtenAnswers()));
  });

  it("has a scenario here for every refusal each route promises, and the other way around", () => {
    const tried = SCENARIOS.filter((one) => one.refused).map(
      ({ method, path, status, refused }) => `${method} ${path} ${status} ${refused}`,
    );
    expect(new Set(tried)).toEqual(new Set(writtenRefusals()));
  });

  it.each(SCENARIOS)("$method $path answers $status $refused as written", async (scenario) => {
    const { method, path, status, refused, ready, solves, times = 1 } = scenario;
    await ready?.();
    let response = await send(scenario);
    if (solves) {
      const { salt, bits } = (await response.json()) as { salt: string; bits: number };
      const proof = await solve(salt, bits);
      for (let n = 0; n < times; n += 1) response = await send(scenario, proof);
    }
    expect(response.status).toBe(status);

    const promised = documented(method, path, status);
    expect(promised).toBeTruthy();
    expect(Object.keys(promised.content)).toContain(response.headers.get("Content-Type"));
    for (const [name, header] of Object.entries(promised.headers ?? {}) as [string, Written][]) {
      if (resolved(header).required) expect(response.headers.has(name)).toBe(true);
    }
    if (response.headers.has("Retry-After")) expect(promised.headers).toHaveProperty("Retry-After");

    const schema = promised.content["application/json"]?.schema;
    if (!schema) return;
    const body = (await response.json()) as Written;
    expect(fits(body, schema)).toBe(true);
    expect(body.refused).toBe(refused);
  });

  it("names every refusal the Worker has, and no other", () => {
    const named = Object.values(spec.components.schemas as Written).flatMap((schema) => refusalsIn(schema));
    expect(new Set(named)).toEqual(new Set(Object.keys(STATUS)));
  });

  it("gives the numbers the rules give", () => {
    const report = spec.components.schemas.Report.properties;
    expect(report.category.enum).toEqual(GRAVE_REPORTS);
    expect(report.detail.maxLength).toBe(LEVEL_ONE.reportDetailAtMost);
    expect(report.sealedLink.maxLength).toBe(LEVEL_ONE.sealedLinkAtMost);
  });

  it("says the fields the status really has", async () => {
    await share();
    const response = await send({ method: "GET", path: "/docs/{id}/admin", status: 200, admin: TOKEN });
    const { status } = (await response.json()) as { status: object };
    const promised = spec.components.schemas.Status.properties.status;
    expect(Object.keys(status).sort()).toEqual([...promised.required].sort());
  });
});

describe("the version that answers", () => {
  const asked = async (tag?: string) => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://tisty.cl/api/v1/docs/${ID}`, {
        headers: { "CF-Connecting-IP": "198.51.100.78" },
      }) as Request<unknown, IncomingRequestCfProperties>,
      { ...testEnv, ...(tag ? { FOLIO_TAG: tag } : {}) } as never,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };

  it("says its tag, so a deploy knows the new one answers", async () => {
    expect((await asked("v1.2.3")).headers.get("Folio-Worker")).toBe("v1.2.3");
  });

  it("says nothing when it has none", async () => {
    expect((await asked()).headers.has("Folio-Worker")).toBe(false);
  });
});

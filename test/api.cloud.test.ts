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

const documented = (method: string, path: string, status: number): Written => {
  const responses = spec.paths[path]?.[method.toLowerCase()]?.responses;
  return resolved(responses?.[status]);
};

interface Scenario {
  method: string;
  path: string;
  status: number;
  admin?: string;
  body?: string;
  braked?: boolean;
  ready?: () => Promise<unknown>;
  solves?: boolean;
}

const send = async ({ method, path, admin, body, braked }: Scenario, proof?: string, ip?: string) => {
  const context = createExecutionContext();
  const headers = new Headers({ "CF-Connecting-IP": ip ?? "198.51.100.77" });
  if (admin) headers.set("Folio-Admin", admin);
  if (proof) headers.set("Folio-Proof", proof);
  const brake = braked ? { READS: { limit: async () => ({ success: false }) } } : {};
  const url = `https://tisty.cl/api/v1${path.replace("{id}", ID)}`;
  const response = await worker.fetch(
    new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...testEnv, FOLIO_SECRET: "09".repeat(32), ALERT_URL: "https://alerts.example/folio", ...brake } as never,
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

const REPORT = JSON.stringify({ category: "phishing" });

const adminRoute = (method: string, path: string, blockable = true): Scenario[] => [
  { method, path, status: 200, admin: TOKEN, ready: share },
  ...(blockable ? [{ method, path, status: 403, admin: TOKEN, ready: block }] : []),
  { method, path, status: 404, admin: "wrong", ready: share },
  { method, path, status: 429, admin: TOKEN, braked: true },
];

const SCENARIOS: Scenario[] = [
  { method: "POST", path: "/start", status: 200 },
  { method: "POST", path: "/start", status: 429, braked: true },
  { method: "GET", path: "/docs/{id}", status: 200, ready: share },
  { method: "GET", path: "/docs/{id}", status: 403, ready: block },
  { method: "GET", path: "/docs/{id}", status: 404 },
  { method: "GET", path: "/docs/{id}", status: 429, braked: true },
  ...adminRoute("DELETE", "/docs/{id}"),
  { method: "POST", path: "/docs/{id}/report", status: 202, body: REPORT, solves: true, ready: share },
  { method: "POST", path: "/docs/{id}/report", status: 400, body: "{}" },
  { method: "POST", path: "/docs/{id}/report", status: 413, body: "x".repeat(20_000) },
  { method: "POST", path: "/docs/{id}/report", status: 429, body: REPORT },
  ...adminRoute("GET", "/docs/{id}/admin", false),
  ...adminRoute("POST", "/docs/{id}/pause"),
  ...adminRoute("POST", "/docs/{id}/resume"),
  { method: "POST", path: "/docs/{id}/appeal", status: 200, admin: TOKEN, ready: block },
  { method: "POST", path: "/docs/{id}/appeal", status: 404, admin: "wrong", ready: block },
  { method: "POST", path: "/docs/{id}/appeal", status: 409, admin: TOKEN, ready: share },
  { method: "POST", path: "/docs/{id}/appeal", status: 429, admin: TOKEN, braked: true },
];

const allWritten = (): string[] =>
  Object.entries(spec.paths as Written).flatMap(([path, item]) =>
    Object.entries(item as Written)
      .filter(([method]) => method !== "parameters")
      .flatMap(([method, operation]) =>
        Object.keys((operation as Written).responses).map((status) => `${method.toUpperCase()} ${path} ${status}`),
      ),
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
  const held = await testEnv.ENVELOPES.list();
  if (held.objects.length > 0) await testEnv.ENVELOPES.delete(held.objects.map((one) => one.key));
});

describe("the written API", () => {
  it("has a scenario here for every answer it promises, and the other way around", () => {
    const tried = SCENARIOS.map(({ method, path, status }) => `${method} ${path} ${status}`);
    expect(new Set(tried)).toEqual(new Set(allWritten()));
  });

  it.each(SCENARIOS)("$method $path answers $status as written", async (scenario) => {
    const { method, path, status, ready, solves } = scenario;
    await ready?.();
    let response = await send(scenario);
    if (solves) {
      const { salt, bits } = (await response.json()) as { salt: string; bits: number };
      response = await send(scenario, await solve(salt, bits));
    }
    expect(response.status).toBe(status);

    const promised = documented(method, path, status);
    expect(promised).toBeTruthy();
    const types = Object.keys(promised.content);
    expect(types).toContain(response.headers.get("Content-Type"));
    if (status < 400) return;
    const { refused } = (await response.json()) as { refused: string };
    expect(refusalsIn(promised.content["application/json"].schema)).toContain(refused);
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
    const written = spec.components.schemas.Status.properties.status;
    expect(Object.keys(status).sort()).toEqual([...written.required].sort());
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

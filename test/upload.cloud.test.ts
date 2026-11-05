import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Cloud } from "../src/cloudflare/store";
import type { Bytes } from "../src/core/bytes";
import { DAY_MS, dayOf, LEVEL_ONE, type Limits } from "../src/core/limits";
import { latestVersion } from "../src/core/read";
import { saltFor, solveProof, startNow, toBase64Url, tokenHash } from "../src/core/start";
import type { Stage, Version } from "../src/core/store";
import { type FirstUpload, uploadDoc } from "../src/core/upload";
import { keptVersions, listFreesAt, uploadAllowedAt } from "../src/core/versions";
import { newPerson, newToken, type Person, rootOf, sealedEnvelope } from "./sealed";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const SECRET = "a secret of the server";
const NOW = Date.UTC(2026, 10, 20, 12);
const LIMITS: Limits = { ...LEVEL_ONE, proofBits: 2 };
const store = new Cloud(testEnv, LIMITS);
const tools = {
  store,
  limits: LIMITS,
  secret: SECRET,
  limiter: { allows: async () => true },
  syncLimiter: { allows: async () => true },
  dayKey: async () => "a key for the day",
};

let mario: Person;
let ana: Person;

// Each start names its own id, so a test takes it from the server and not the other way around.
const started = async (now = NOW): Promise<FirstUpload & { id: string }> => {
  const { id, mac } = await startNow(SECRET, now);
  const proof = await solveProof(await saltFor(SECRET, id, Math.floor(now / 3_600_000)), LIMITS.proofBits);
  return { id, start: mac, proof, adminToken: "the admin token", ttlDays: 3 };
};

const send = (id: string, bytes: Bytes, now = NOW, first?: FirstUpload) =>
  uploadDoc({ id, now, ip: "203.0.113.9", bytes: async () => bytes, ...(first ? { first } : {}) }, tools);

const shared = async (over: { permit?: string } = {}) => {
  const first = await started();
  const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario, ...over });
  expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
  return first.id;
};

const row = (id: string) =>
  testEnv.DB.prepare("SELECT owner, permit, latest, versions, owner_mark, paused_at FROM docs WHERE id = ?")
    .bind(id)
    .first<{ owner: string; permit: string | null; latest: number; versions: string; owner_mark: string }>();

const LATER = NOW + 2 * DAY_MS;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  mario = await newPerson();
  ana = await newPerson();
});

beforeEach(async () => {
  for (const table of ["docs", "net_day", "net_hour", "service_stage"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("sharing something new", () => {
  it("keeps who owns it and when it arrived, with the time of the server", async () => {
    const id = await shared();
    const held = await row(id);
    expect(held?.owner).toBe(rootOf(mario));
    const [version] = JSON.parse(held?.versions ?? "[]") as Version[];
    expect(version).toMatchObject({ n: 1, at: NOW, signer: rootOf(mario), contract: expect.any(String) });
    expect(await testEnv.ENVELOPES.head(`${id}/1.${version?.hash}`)).not.toBeNull();
  });

  it("keeps who may edit, from what its owner signed", async () => {
    const { permit } = await newToken();
    expect((await row(await shared({ permit })))?.permit).toBe(permit);
  });

  it("takes the same bytes again as the same version", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    await send(first.id, bytes, NOW, first);
    expect(await send(first.id, bytes, NOW + 1, first)).toEqual({ stored: true, version: 1 });
    expect((await row(first.id))?.latest).toBe(1);
  });

  it("asks for what the server gave, and for the proof", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    expect(await send(first.id, bytes)).toEqual({ refused: "missing" });
    expect(await send(first.id, bytes, NOW, { ...first, start: "not what it gave" })).toEqual({
      refused: "bad_upload",
    });
    expect(await send(first.id, bytes, NOW, { ...first, adminToken: "" })).toEqual({ refused: "bad_upload" });
    expect(await send(first.id, bytes, NOW, { ...first, ttlDays: 2 })).toEqual({ refused: "bad_upload" });
    expect((await row(first.id))?.latest).toBeUndefined();
  });

  it("does not take a retry that brings another admin token, or the owner would lose the link", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    await store.create(
      { id: first.id, owner: rootOf(mario), adminHash: await tokenHash("the admin token"), ttlDays: 3, net: "n" },
      dayOf(NOW),
    );
    expect(await send(first.id, bytes, NOW, { ...first, adminToken: "another one" })).toEqual({ refused: "not_yours" });
    expect((await row(first.id))?.latest).toBe(0);
    expect(await send(first.id, bytes, NOW, first)).toEqual({ stored: true, version: 1 });
  });

  it("asks for the proof before it keeps anything", async () => {
    const hard = { ...tools, limits: { ...LIMITS, proofBits: 24 } };
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    const answer = await uploadDoc(
      { id: first.id, now: NOW, ip: "203.0.113.9", bytes: async () => bytes, first },
      hard,
    );
    expect(answer).toMatchObject({ refused: "proof", bits: 24 });
    expect(await row(first.id)).toBeNull();
  });

  it("stops at the shares a person may keep", async () => {
    for (let at = 0; at < LIMITS.sharesAtMost; at += 1) await shared();
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 1, owner: mario });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "shares_full" });
  });

  it("refuses what is sealed for another id, and what does not hold", async () => {
    const first = await started();
    const other = await sealedEnvelope({ id: "anotherO", version: 1, owner: mario });
    expect(await send(first.id, other, NOW, first)).toEqual({ refused: "envelope", why: "damaged" });
    const editor = await sealedEnvelope({ id: first.id, version: 1, owner: mario, signer: ana });
    expect(await send(first.id, editor, NOW, first)).toEqual({ refused: "envelope", why: "unsigned" });
  });
});

describe("who may send a new version", () => {
  it("is its owner, from any machine and under any name", async () => {
    const id = await shared();
    const otherName = new Uint8Array(32).fill(9);
    const next = await sealedEnvelope({ id, version: 2, owner: mario, nameTag: otherName });
    expect(await send(id, next, LATER)).toEqual({ stored: true, version: 2 });
    expect((await row(id))?.owner_mark).toContain(toBase64Url(otherName));
  });

  it("is nobody else, when its owner allowed no one", async () => {
    const id = await shared();
    const stolen = await sealedEnvelope({ id, version: 2, owner: ana });
    expect(await send(id, stolen, LATER)).toEqual({ refused: "not_yours" });
  });

  it("is who holds the token, under the block its owner signed", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const edited = await sealedEnvelope({ id, version: 2, owner: mario, signer: ana, permit, token: pair });
    expect(await send(id, edited, LATER)).toEqual({ stored: true, version: 2 });
    const [, second] = JSON.parse((await row(id))?.versions ?? "[]") as Version[];
    expect(second?.signer).toBe(rootOf(ana));
  });

  it("is not who holds a token its owner took back, or who brings an old block", async () => {
    const old = await newToken();
    const id = await shared({ permit: old.permit });
    const fresh = await newToken();
    await store.setPermit(id, fresh.permit);
    const edited = await sealedEnvelope({
      id,
      version: 2,
      owner: mario,
      signer: ana,
      permit: old.permit,
      token: old.pair,
    });
    expect(await send(id, edited, LATER)).toEqual({ refused: "not_yours" });
    expect((await row(id))?.permit).toBe(fresh.permit);
  });

  it("does not let an upload change who may edit", async () => {
    const id = await shared();
    const { permit } = await newToken();
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario, permit });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "not_yours" });
    expect((await row(id))?.permit).toBeNull();
  });

  it("does not let an editor change the owner's name", async () => {
    const { pair, permit } = await newToken();
    const id = await shared({ permit });
    const bytes = await sealedEnvelope({
      id,
      version: 2,
      owner: mario,
      signer: ana,
      permit,
      token: pair,
      nameTag: new Uint8Array(32).fill(9),
    });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "not_yours" });
  });
});

describe("what is refused writes nothing", () => {
  const counted = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM net_hour").first<{ n: number }>();

  it("a first version that is not the first, which takes no place among their shares", async () => {
    const first = await started();
    const bytes = await sealedEnvelope({ id: first.id, version: 3, owner: mario });
    expect(await send(first.id, bytes, NOW, first)).toEqual({ refused: "behind" });
    expect(await row(first.id)).toBeNull();
  });

  it("one that is behind, paused or blocked, or spends the network's uploads", async () => {
    const id = await shared();
    await testEnv.DB.prepare("DELETE FROM net_hour").run();
    expect(await send(id, await sealedEnvelope({ id, version: 3, owner: mario }), LATER)).toEqual({
      refused: "behind",
    });
    await store.pause(id, dayOf(NOW));
    const next = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await send(id, next, LATER)).toEqual({ refused: "paused" });
    expect((await counted())?.n).toBe(0);
  });

  it("reads no body for a document that is not there, or a first one with no proof", async () => {
    const bytes = vi.fn(async () => new Uint8Array(1));
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, tools);
    const hard = { ...tools, limits: { ...LIMITS, proofBits: 24 } };
    const first = await started();
    await uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes, first }, hard);
    await uploadDoc({ id: first.id, now: NOW, ip: "203.0.113.9", bytes, first: { ...first, start: "x" } }, tools);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("reads no body for what the brake or the stage stop", async () => {
    const bytes = vi.fn(async () => new Uint8Array(1));
    const braked = { ...tools, limiter: { allows: async () => false } };
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, braked);
    await store.setStage("no_uploads");
    await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes }, tools);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("refuses what says it is past the size, or does not fit", async () => {
    const id = await shared();
    const answer = await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => null }, tools);
    expect(answer).toEqual({ refused: "too_big" });
  });
});

describe("what stops a version", () => {
  it("one that is not the next says it is behind, and nothing else", async () => {
    const id = await shared();
    expect(await send(id, await sealedEnvelope({ id, version: 3, owner: mario }), LATER)).toEqual({
      refused: "behind",
    });
  });

  it("a paused or blocked document", async () => {
    const id = await shared();
    await store.pause(id, dayOf(NOW));
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "paused",
    });
    await testEnv.DB.prepare("UPDATE docs SET paused_at = NULL, blocked_at = 1 WHERE id = ?").bind(id).run();
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "blocked",
    });
  });

  it.each(["no_uploads", "blocked"] as Stage[])("the spending stage %s", async (stage) => {
    const id = await shared();
    await store.setStage(stage);
    expect(await send(id, await sealedEnvelope({ id, version: 2, owner: mario }), LATER)).toEqual({
      refused: "uploads_off",
    });
  });

  it("past its tops, by what its manifest says", async () => {
    const id = await shared();
    const version = 2;
    const tooManyPictures = Array.from({ length: LIMITS.picturesAtMost + 1 }, () => 4);
    for (const over of [
      { pictures: tooManyPictures },
      { pictures: [LIMITS.pictureBytesAtMost + 1] },
      { firstBytes: LIMITS.firstBytesAtMost + 1 },
    ]) {
      expect(await send(id, await sealedEnvelope({ id, version, owner: mario, ...over }), LATER)).toEqual({
        refused: "too_big",
      });
    }
    const small = { ...tools, limits: { ...LIMITS, envelopeBytesAtMost: 10 } };
    const bytes = await sealedEnvelope({ id, version, owner: mario });
    expect(await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes }, small)).toEqual({
      refused: "too_big",
    });
  });

  it("a contract under the floor, once there is one", async () => {
    const id = await shared();
    const floored = { ...tools, limits: { ...LIMITS, oldestContractTaken: "1.3.0" } };
    const bytes = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await uploadDoc({ id, now: LATER, ip: "203.0.113.9", bytes: async () => bytes }, floored)).toEqual({
      refused: "outdated",
    });
  });

  it("a brake that says no", async () => {
    const braked = { ...tools, limiter: { allows: async () => false } };
    const bytes = await sealedEnvelope({ id: "AbCdEfGh", version: 1, owner: mario });
    const answer = await uploadDoc({ id: "AbCdEfGh", now: NOW, ip: "203.0.113.9", bytes: async () => bytes }, braked);
    expect(answer).toMatchObject({ refused: "slow" });
  });

  it("waiting after the last press, and writes nothing while it does", async () => {
    const id = await shared();
    const before = await row(id);
    const next = await sealedEnvelope({ id, version: 2, owner: mario });
    expect(await send(id, next, NOW + 1000)).toEqual({ refused: "slow", until: NOW + 60_000 });
    expect(await row(id)).toEqual(before);
    expect(await send(id, next, NOW + 60_000)).toEqual({ stored: true, version: 2 });
  });
});

const versionsAt = (signer: string, ...ats: number[]): Version[] =>
  ats.map((at, index) => ({ n: index + 1, hash: `h${index}`, bytes: 1, at, signer, contract: "1.2.0" }));
const MINUTE = 60_000;

describe("the waits of the button", () => {
  it("are the ones decided, in a row", () => {
    const presses = [0, 1, 2, 3, 5, 9, 17].map((one) => one * MINUTE);
    const expected = [1, 1, 1, 2, 4, 8, 15];
    presses.forEach((_, at) => {
      const made = versionsAt("a", ...presses.slice(0, at + 1));
      const last = presses[at] as number;
      expect(uploadAllowedAt(made, "a", last, LEVEL_ONE)).toBe(last + (expected[at] as number) * MINUTE);
    });
  });

  it("stay at the longest", () => {
    const presses = [0, 1, 2, 3, 5, 9, 17, 32, 47].map((one) => one * MINUTE);
    const last = presses.at(-1) as number;
    expect(uploadAllowedAt(versionsAt("a", ...presses), "a", last, { ...LEVEL_ONE, uploadsOfARootAnHour: 100 })).toBe(
      last + 15 * MINUTE,
    );
  });

  it("start over after half an hour with no press", () => {
    const made = versionsAt("a", 0, MINUTE, 2 * MINUTE);
    expect(uploadAllowedAt(made, "a", 40 * MINUTE, LEVEL_ONE)).toBe(40 * MINUTE);
    const after = versionsAt("a", 0, MINUTE, 40 * MINUTE);
    expect(uploadAllowedAt(after, "a", 40 * MINUTE, LEVEL_ONE)).toBe(41 * MINUTE);
  });

  it("are each person's, so a team does not wait on each other", () => {
    const made = versionsAt("a", 0, MINUTE, 2 * MINUTE);
    expect(uploadAllowedAt(made, "b", 2 * MINUTE, LEVEL_ONE)).toBe(2 * MINUTE);
  });

  it("hold ten an hour even after half an hour with no press", () => {
    const ten = Array.from({ length: 10 }, (_, at) => at * 2 * MINUTE);
    expect(uploadAllowedAt(versionsAt("a", ...ten), "a", 49 * MINUTE, LEVEL_ONE)).toBe(60 * MINUTE);
  });

  it("hold ten an hour", () => {
    const ten = Array.from({ length: 10 }, (_, at) => at * 2 * MINUTE);
    const made = versionsAt("a", ...ten);
    const quick = { ...LEVEL_ONE, uploadWaitsMinutes: [0] };
    expect(uploadAllowedAt(made, "a", 19 * MINUTE, quick)).toBe(60 * MINUTE);
  });
});

describe("the versions it keeps", () => {
  const DAY = DAY_MS;

  it("keeps the last ones and what was replaced in the last days", () => {
    const made = versionsAt("a", 0, DAY, 2 * DAY, 20 * DAY, 21 * DAY, 22 * DAY);
    expect(keptVersions(made, 22 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([3, 4, 5, 6]);
  });

  it("keeps everything replaced in the last seven days, however many", () => {
    const made = versionsAt("a", 0, 1, 2, 3, 4, 5, 6);
    expect(keptVersions(made, 7, LEVEL_ONE)).toHaveLength(7);
  });

  it("counts from when a version was replaced, and not from when it arrived", () => {
    const made = versionsAt("a", 0, 30 * DAY, 31 * DAY, 32 * DAY, 33 * DAY);
    const kept = keptVersions(made, 33 * DAY, LEVEL_ONE).map((one) => one.n);
    expect(kept).toEqual([1, 2, 3, 4, 5]);
    expect(keptVersions(made, 38 * DAY, LEVEL_ONE).map((one) => one.n)).toEqual([3, 4, 5]);
  });

  it("refuses past the list's size rather than letting evidence go", async () => {
    const id = await shared();
    const many = versionsAt(rootOf(mario), ...Array.from({ length: LIMITS.versionsListedAtMost }, (_, at) => NOW + at));
    await testEnv.DB.prepare("UPDATE docs SET latest = ?, versions = ? WHERE id = ?")
      .bind(many.length, JSON.stringify(many), id)
      .run();
    const bytes = await sealedEnvelope({ id, version: many.length + 1, owner: mario });
    expect(await send(id, bytes, LATER)).toEqual({ refused: "quota", until: NOW + 1 + 7 * DAY_MS });
  });

  it("says when a full list frees, and nothing while it has room", () => {
    const room = versionsAt("a", 0, 1, 2);
    expect(listFreesAt(room, 3, LEVEL_ONE)).toBeNull();
    const full = versionsAt("a", ...Array.from({ length: LEVEL_ONE.versionsListedAtMost }, (_, at) => at * 1000));
    expect(listFreesAt(full, 300_000, LEVEL_ONE)).toBe(1000 + 7 * DAY);
  });
});

describe("asking which version there is", () => {
  const counted = (id: string) => latestVersion({ id, now: NOW, ip: "203.0.113.9" }, tools);

  it("says the version and its hash, and writes nothing", async () => {
    const id = await shared();
    const before = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first();
    const held = JSON.parse((await row(id))?.versions ?? "[]") as Version[];
    expect(await counted(id)).toEqual({ version: 1, hash: held[0]?.hash });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first()).toEqual(before);
  });

  it("refuses what a read refuses", async () => {
    expect(await counted("nothing0")).toEqual({ refused: "missing" });
    const id = await shared();
    await store.pause(id, dayOf(NOW));
    expect(await counted(id)).toEqual({ refused: "paused" });
  });

  it("is held back by its own brake, by network and document", async () => {
    const seen: string[] = [];
    const answer = await latestVersion(
      { id: "AbCdEfGh", now: NOW, ip: "203.0.113.9" },
      {
        ...tools,
        syncLimiter: {
          allows: async (key) => {
            seen.push(key);
            return false;
          },
        },
      },
    );
    expect(answer).toMatchObject({ refused: "slow" });
    expect(seen[0]).toMatch(/\|AbCdEfGh$/);
  });
});

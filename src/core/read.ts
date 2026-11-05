import type { Revocation } from "@tisty/contracts";
import { isBelowVersion } from "../rules/envelope";
import { dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import { askForProof, type Refused, tooFast } from "./refused";
import { proofIsFresh } from "./start";
import type { Reading, Shown, Store, Version } from "./store";

export interface Asked {
  id: string;
  ip: string;
  now: number;
  proof?: string;
}

export interface Asking {
  id: string;
  ip: string;
  now: number;
}

export interface Limiter {
  allows(key: string): Promise<boolean>;
}

export interface ReadTools {
  store: Store;
  limiter: Limiter;
  limits: Limits;
  secret: string;
  dayKey: (today: number) => Promise<string>;
}

export interface SyncTools extends ReadTools {
  syncLimiter: Limiter;
}

export interface Served {
  served: true;
  version: Version;
  diesOn: number;
  body: ReadableStream;
  revocations: Revocation[];
  // What is written once the answer left, so a read never waits for a write (decision 105).
  note?: Reading;
}

const refusalOfState = (shown: Shown | null, { oldestContractServed: floor }: Limits): Refused | null => {
  if (!shown?.version) return { refused: "missing" };
  if (shown.blockedAt !== null) return { refused: "blocked" };
  if (!shown.alive) return { refused: "missing" };
  if (floor !== null && isBelowVersion(shown.version.contract, floor)) return { refused: "outdated" };
  return shown.pausedAt === null ? null : { refused: "paused" };
};

export const latestVersion = async (
  { id, ip, now }: Asking,
  { store, limiter, syncLimiter, limits, dayKey }: SyncTools,
): Promise<{ version: number; hash: string } | Refused> => {
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net)) || !(await syncLimiter.allows(`${net}|${id}`))) return tooFast(now);
  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown, limits);
  if (refused || !shown?.version) return refused ?? { refused: "missing" };
  return { version: shown.version.n, hash: shown.version.hash };
};

export const readDoc = async ({ id, ip, now, proof }: Asked, tools: ReadTools): Promise<Served | Refused> => {
  const { store, limiter, limits, secret, dayKey } = tools;
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return tooFast(now);

  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown, limits);
  if (refused || !shown?.version) return refused ?? { refused: "missing" };

  const scope = `read|${id}|${net}`;
  const proved = proof !== undefined && (await proofIsFresh(secret, scope, proof, limits.proofBits, now));
  const reading: Reading = {
    owner: shown.owner,
    reader: net,
    doc: id,
    hour: new Date(now).getUTCHours(),
    proved,
  };
  const admitted = await store.admit(reading, today);
  if (admitted === "over") return askForProof(secret, scope, limits.proofBits, now);

  const [body, revocations] = await Promise.all([
    store.envelope(id, shown.version),
    store.revocationsOf([shown.version.signer, shown.owner]),
  ]);
  if (!body) return { refused: "missing" };
  return {
    served: true,
    version: shown.version,
    diesOn: shown.diesOn,
    body,
    revocations,
    ...(admitted === "new" ? { note: reading } : {}),
  };
};

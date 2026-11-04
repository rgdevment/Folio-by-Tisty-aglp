import { dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import { proofIsFresh, saltFor } from "./start";
import type { Reading, Shown, Store, Version } from "./store";

export interface Asked {
  id: string;
  ip: string;
  now: number;
  proof?: string;
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

export type Refused =
  | { refused: "missing" | "paused" | "blocked" }
  | { refused: "slow"; until: number }
  | { refused: "proof"; salt: string; bits: number };

export interface Served {
  served: true;
  version: Version;
  diesOn: number;
  body: ReadableStream;
  // What is written once the answer left, so a read never waits for a write (decision 105).
  note?: Reading;
}

const SECOND_MS = 1000;
const LIMITER_WINDOW_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * 60 * SECOND_MS;

const refusalOfState = (shown: Shown | null): Refused | null => {
  if (!shown?.version) return { refused: "missing" };
  if (shown.blockedAt !== null) return { refused: "blocked" };
  if (shown.pausedAt !== null) return { refused: "paused" };
  return shown.alive ? null : { refused: "missing" };
};

export const readDoc = async ({ id, ip, now, proof }: Asked, tools: ReadTools): Promise<Served | Refused> => {
  const { store, limiter, limits, secret, dayKey } = tools;
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return { refused: "slow", until: now + LIMITER_WINDOW_MS };

  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown);
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
  if (admitted === "over") {
    return {
      refused: "proof",
      salt: await saltFor(secret, scope, Math.floor(now / HOUR_MS)),
      bits: limits.proofBits,
    };
  }

  const body = await store.envelope(id, shown.version);
  if (!body) return { refused: "missing" };
  return {
    served: true,
    version: shown.version,
    diesOn: shown.diesOn,
    body,
    ...(admitted === "new" ? { note: reading } : {}),
  };
};

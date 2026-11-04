import { DAY_MS, dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import { passwordHolds } from "./password";
import { proofIsFresh, saltFor } from "./start";
import type { Reading, Shown, Store, Version } from "./store";

export interface Asked {
  id: string;
  ip: string;
  now: number;
  password?: string;
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
  | { refused: "missing" | "paused" | "blocked" | "password" | "wrong" }
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

const proofAsked = async (secret: string, scope: string, bits: number, now: number): Promise<Refused> => ({
  refused: "proof",
  salt: await saltFor(secret, scope, Math.floor(now / HOUR_MS)),
  bits,
});

const refusalOfPassword = async (
  { id, password, proof, now }: Asked,
  shown: Shown,
  net: string,
  { store, limits, secret }: ReadTools,
): Promise<Refused | null> => {
  if (shown.password === null) return null;
  if (password === undefined) return { refused: "password" };

  const slotMs = DAY_MS / limits.guessSlotsADay;
  const slot = Math.floor(now / slotMs);
  if ((await store.wrongGuesses(id, net, slot)) >= limits.guessesPerSlot) {
    return { refused: "slow", until: (slot + 1) * slotMs };
  }
  const today = dayOf(now);
  if (shown.guessDay === today && shown.guessCount >= limits.guessesBeforeProof) {
    const scope = `guess|${id}|${net}`;
    const holds = proof !== undefined && (await proofIsFresh(secret, scope, proof, limits.proofBits, now));
    if (!holds) return proofAsked(secret, scope, limits.proofBits, now);
  }
  // Noted before answering, unlike a reader: otherwise guesses sent all at once would all pass the count.
  if (await passwordHolds(shown.password, password)) return null;
  await store.noteWrongGuess(id, net, slot, today);
  return { refused: "wrong" };
};

export const readDoc = async (asked: Asked, tools: ReadTools): Promise<Served | Refused> => {
  const { id, ip, now, proof } = asked;
  const { store, limiter, limits, secret, dayKey } = tools;
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return { refused: "slow", until: now + LIMITER_WINDOW_MS };

  const shown = await store.shown(id, today);
  const refused = refusalOfState(shown);
  if (refused || !shown?.version) return refused ?? { refused: "missing" };
  const byPassword = await refusalOfPassword(asked, shown, net, tools);
  if (byPassword) return byPassword;

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
  if (admitted === "over") return proofAsked(secret, scope, limits.proofBits, now);

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

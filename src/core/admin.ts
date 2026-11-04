import { dayOf } from "./limits";
import { netDigest } from "./net";
import type { Refused } from "./refused";
import type { ReportTools } from "./report";
import { sameText, tokenHash } from "./start";
import type { DocStatus, Store } from "./store";

export type AdminAction = "status" | "pause" | "resume" | "stop" | "appeal";

export interface Administering {
  id: string;
  ip: string;
  now: number;
  token: string;
  action: AdminAction;
}

export type AdminTools = Pick<ReportTools, "store" | "limiter" | "dayKey" | "alert">;
export type AdminAnswer = { done: true } | { status: DocStatus } | Refused;

const LIMITER_WINDOW_MS = 60_000;

const CHANGES: Record<"pause" | "resume" | "stop", (store: Store, id: string, today: number) => Promise<void>> = {
  pause: (store, id, today) => store.pause(id, today),
  resume: (store, id, today) => store.resume(id, today),
  stop: (store, id, today) => store.stop(id, today),
};

// The alert goes first, so one that fails leaves the appeal free to be sent again (decision 36).
const appeal = async (
  id: string,
  { blockedAt, appealedAt }: DocStatus,
  today: number,
  { store, alert }: AdminTools,
): Promise<AdminAnswer> => {
  if (blockedAt === null) return { refused: "not_blocked" };
  if (appealedAt !== null && appealedAt >= blockedAt) return { refused: "appealed" };
  await alert({ doc: id, reason: "appeal" });
  await store.appeal(id, today);
  return { done: true };
};

export const administer = async (
  { id, ip, now, token, action }: Administering,
  tools: AdminTools,
): Promise<AdminAnswer> => {
  const { store, limiter, dayKey } = tools;
  const today = dayOf(now);
  if (!(await limiter.allows(await netDigest(await dayKey(today), ip)))) {
    return { refused: "slow", until: now + LIMITER_WINDOW_MS };
  }
  const owned = await store.owned(id, today);
  // A wrong token and a missing document look the same, so the admin link is the only way to learn anything.
  if (!owned || !sameText(await tokenHash(token), owned.adminHash)) return { refused: "missing" };

  if (action === "status") return { status: owned.status };
  if (action === "appeal") return appeal(id, owned.status, today, tools);
  if (owned.status.blockedAt !== null) return { refused: "blocked" };
  await CHANGES[action](store, id, today);
  return { done: true };
};

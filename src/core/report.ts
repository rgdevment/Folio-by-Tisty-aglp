import { dayOf, GRAVE_REPORTS, type Limits } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { askForProof, type Refused } from "./refused";
import { hourEnds, hourOf, proofIsFresh } from "./start";

export interface Alert {
  doc: string;
  reason: "csam" | "blocked" | "appeal";
}

export interface ReportTools extends ReadTools {
  evidenceKey: (today: number) => Promise<string>;
  alert: (said: Alert) => Promise<void>;
}

export interface Said {
  category: string;
  detail?: string;
  sealedLink?: string;
}

export interface Reporting {
  id: string;
  ip: string;
  asn: number;
  now: number;
  said: Said;
  proof?: string;
}

const isTextUpTo = (value: unknown, atMost: number): boolean =>
  value === undefined || (typeof value === "string" && value.length <= atMost);

export const saidOf = (body: unknown, limits: Limits): Said | null => {
  if (typeof body !== "object" || body === null) return null;
  const { category, detail, sealedLink } = body as Record<string, unknown>;
  if (typeof category !== "string" || !GRAVE_REPORTS.includes(category)) return null;
  if (!isTextUpTo(detail, limits.reportDetailAtMost) || !isTextUpTo(sealedLink, limits.sealedLinkAtMost)) return null;
  return {
    category,
    ...(detail === undefined ? {} : { detail: detail as string }),
    ...(sealedLink === undefined ? {} : { sealedLink: sealedLink as string }),
  };
};

// Nothing is written before the proof, so a flood of reports costs no rows (decision 41).
export const reportDoc = async (
  { id, ip, asn, now, said, proof }: Reporting,
  { store, limits, secret, dayKey, evidenceKey, alert }: ReportTools,
): Promise<{ received: true } | Refused> => {
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  const scope = `report|${id}|${net}`;
  const proved = proof !== undefined && (await proofIsFresh(secret, scope, proof, limits.proofBits, now));
  if (!proved) return askForProof(secret, scope, limits.proofBits, now);
  if (!(await store.takeHourly(net, "report", hourOf(now), limits.reportsAnHour))) {
    return { refused: "quota", until: hourEnds(now) };
  }

  const reporter = await netDigest(await evidenceKey(today), ip);
  const { pending } = await store.report({ doc: id, net: reporter, asn, ...said }, today);
  // Marked once it went, so a failed alert fails the report, and sending it again alerts again (decision 36).
  for (const reason of pending) {
    await alert({ doc: id, reason });
    await store.told(id, reason);
  }
  return { received: true };
};

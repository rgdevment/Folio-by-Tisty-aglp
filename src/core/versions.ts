import { DAY_MS, type Limits } from "./limits";
import type { Version } from "./store";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Replaced versions stay a while, so five clean uploads cannot erase what someone is about to report (decision 152).
export const keptVersions = (all: Version[], now: number, limits: Limits): Version[] =>
  all.filter((_, at) => {
    const replacedBy = all[at + 1];
    return (
      !replacedBy || at >= all.length - limits.versionsKept || now - replacedBy.at < limits.replacedKeptDays * DAY_MS
    );
  });

const streakOf = (own: Version[], limits: Limits): number => {
  const resetsAfter = limits.uploadStreakResetMinutes * MINUTE_MS;
  let streak = 1;
  for (let at = own.length - 1; at > 0; at -= 1) {
    if ((own[at] as Version).at - (own[at - 1] as Version).at >= resetsAfter) break;
    streak += 1;
  }
  return streak;
};

export const uploadAllowedAt = (versions: Version[], signer: string, now: number, limits: Limits): number => {
  const own = versions.filter((one) => one.signer === signer);
  const last = own.at(-1);
  if (!last || now - last.at >= limits.uploadStreakResetMinutes * MINUTE_MS) return now;

  const waits = limits.uploadWaitsMinutes;
  const wait = waits[Math.min(streakOf(own, limits) - 1, waits.length - 1)] ?? 0;
  const afterTheWait = last.at + wait * MINUTE_MS;
  const inTheHour = own.filter((one) => now - one.at < HOUR_MS);
  const oldest = inTheHour[0];
  const afterTheHour = oldest && inTheHour.length >= limits.uploadsOfARootAnHour ? oldest.at + HOUR_MS : now;
  return Math.max(afterTheWait, afterTheHour, now);
};

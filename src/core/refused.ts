import { hourOf, saltFor } from "./start";

export type Refused =
  | { refused: "missing" | "paused" | "blocked" | "bad_report" | "too_big" | "not_blocked" | "appealed" }
  | { refused: "slow" | "quota"; until: number }
  | { refused: "proof"; salt: string; bits: number };

export const askForProof = async (secret: string, scope: string, bits: number, now: number): Promise<Refused> => ({
  refused: "proof",
  salt: await saltFor(secret, scope, hourOf(now)),
  bits,
});

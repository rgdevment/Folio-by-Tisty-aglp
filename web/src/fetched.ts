export type Refusal = { readonly refused: string };

// What the server holds in the clear beside the envelope, in seconds since 1970.
export type Facts = {
  readonly shared?: number;
  readonly written?: number;
  readonly ends?: number;
  readonly gated: boolean;
};

const API = "/api/v1";

// A server that fails is down whatever word it gives, so the reader is told to come back, not that the link is wrong.
const refusalOf = async (answer: Response): Promise<string> => {
  if (answer.status >= 500) return "down";
  try {
    const said = (await answer.json()) as { refused?: unknown };
    if (typeof said.refused === "string") return said.refused;
  } catch {
    // A body that is no refusal says no more than its status.
  }
  return "unknown";
};

const asked = async <T>(
  path: string,
  ask: typeof fetch,
  read: (answer: Response) => Promise<T>,
  init?: RequestInit,
): Promise<T | Refusal> => {
  try {
    const answer = await ask(`${API}/${path}`, init);
    return answer.ok ? await read(answer) : { refused: await refusalOf(answer) };
  } catch {
    return { refused: "offline" };
  }
};

const secondsOf = (said: string | null): number | undefined => {
  const seconds = Number(said ?? Number.NaN);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
};

export const factsOf = (headers: Headers): Facts => ({
  shared: secondsOf(headers.get("Tisty-Shared")),
  written: secondsOf(headers.get("Tisty-Written")),
  ends: secondsOf(headers.get("Tisty-Ends")),
  gated: headers.get("Tisty-Gated") === "1",
});

// A header carries only Latin-1, so a password in any language travels as its UTF-8, which the Worker decodes.
export const passwordOf = (password: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(password)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

// The password travels in a header of its own, so it never sits in a URL or a log.
export const fetched = (id: string, ask: typeof fetch = fetch, password?: string) =>
  asked(
    `docs/${encodeURIComponent(id)}`,
    ask,
    async (answer) => ({
      sealed: new Uint8Array(await answer.arrayBuffer()),
      facts: factsOf(answer.headers),
      // The keys taken back that sent it, which the page believes only as far as their roots signed them.
      revoked: answer.headers.get("Tisty-Revoked") ?? undefined,
    }),
    password === undefined ? undefined : { headers: { "Tisty-Password": passwordOf(password) } },
  );

export const limitsOf = (ask: typeof fetch = fetch) =>
  asked("limits", ask, async (answer) => ({ limits: await answer.text() }));

// The reasons the server takes, in the order the form offers them (decision 38).
export const REASONS = [
  "child_abuse",
  "explicit",
  "intimate",
  "phishing",
  "malware",
  "fraud",
  "threat",
  "doxxing",
] as const;

export type Reason = (typeof REASONS)[number];

// A report costs a proof of work as an upload does (decision 41), worked in the page from the server's challenge.
export const reported = async (
  id: string,
  reason: Reason,
  detail: string,
  solve: (challenge: string) => Promise<string | undefined>,
  ask: typeof fetch = fetch,
): Promise<string> => {
  const challenge = await asked("challenge", ask, (answer) => answer.text(), {
    method: "POST",
    body: JSON.stringify({ for: "report", id }),
  });
  if (typeof challenge !== "string") return challenge.refused;
  const work = await solve(challenge);
  if (!work) return "failed";
  const answer = await asked(
    `docs/${encodeURIComponent(id)}/reports`,
    ask,
    () => Promise.resolve("thanked"),
    {
      method: "POST",
      headers: { "Tisty-Work": work, "Content-Type": "application/json" },
      body: JSON.stringify({ category: reason, detail }),
    },
  );
  return typeof answer === "string" ? answer : answer.refused;
};

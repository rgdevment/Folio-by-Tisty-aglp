export type Refusal = { readonly refused: string };

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
): Promise<T | Refusal> => {
  try {
    const answer = await ask(`${API}/${path}`);
    return answer.ok ? await read(answer) : { refused: await refusalOf(answer) };
  } catch {
    return { refused: "offline" };
  }
};

export const fetched = (id: string, ask: typeof fetch = fetch) =>
  asked(`docs/${encodeURIComponent(id)}`, ask, async (answer) => ({
    sealed: new Uint8Array(await answer.arrayBuffer()),
  }));

export const limitsOf = (ask: typeof fetch = fetch) =>
  asked("limits", ask, async (answer) => ({ limits: await answer.text() }));

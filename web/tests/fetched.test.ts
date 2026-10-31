import { describe, expect, it } from "vitest";
import { fetched, limitsOf, reported } from "../src/fetched";

const answering = (answer: () => Response) => (async () => answer()) as typeof fetch;

describe("what the server answers for a link", () => {
  it("is the sealed bytes, what the server holds in the clear beside them, and the keys taken back", async () => {
    const headers = {
      "Tisty-Shared": "1793000000",
      "Tisty-Written": "1793100000",
      "Tisty-Ends": "1795600000",
      "Tisty-Gated": "1",
      "Tisty-Revoked": '[{"root":"r"}]',
    };
    const said = await fetched(
      "k7Qm2xPa",
      answering(() => new Response(new Uint8Array([1, 2, 3]), { headers })),
    );
    expect(said).toEqual({
      sealed: new Uint8Array([1, 2, 3]),
      facts: { shared: 1_793_000_000, written: 1_793_100_000, ends: 1_795_600_000, gated: true },
      revoked: '[{"root":"r"}]',
    });
  });

  it("leaves out what the server did not tell, or told badly", async () => {
    const headers = { "Tisty-Shared": "ayer", "Tisty-Ends": "-5", "Tisty-Gated": "0" };
    const said = await fetched(
      "k7Qm2xPa",
      answering(() => new Response("", { headers })),
    );
    expect("facts" in said && said.facts).toEqual({
      shared: undefined,
      written: undefined,
      ends: undefined,
      gated: false,
    });
  });

  it("asks for the document the link names, with the password as its UTF-8 only when there is one", async () => {
    const asked: [string, string | null][] = [];
    const ask = (async (url: RequestInfo | URL, init?: RequestInit) => {
      asked.push([String(url), new Headers(init?.headers).get("Tisty-Password")]);
      return new Response("");
    }) as typeof fetch;
    await fetched("k7Qm2xPa", ask);
    await fetched("k7Qm2xPa", ask, "perro azul");
    await fetched("k7Qm2xPa", ask, "ñandú €🔑");
    expect(asked).toEqual([
      ["/api/v1/docs/k7Qm2xPa", null],
      ["/api/v1/docs/k7Qm2xPa", "cGVycm8gYXp1bA"],
      ["/api/v1/docs/k7Qm2xPa", "w7FhbmTDuiDigqzwn5SR"],
    ]);
  });

  it("is the word of its refusal", async () => {
    const missing = () => new Response('{"refused":"missing"}', { status: 404 });
    expect(await fetched("k7Qm2xPa", answering(missing))).toEqual({ refused: "missing" });
  });

  it("is unknown when a refusal carries no word", async () => {
    const bare = () => new Response("<html>", { status: 404 });
    expect(await fetched("k7Qm2xPa", answering(bare))).toEqual({ refused: "unknown" });
  });

  it("says down when the server fails, whatever word it gives", async () => {
    for (const broken of [
      () => new Response("<html>", { status: 502 }),
      () => new Response('{"refused":"crowded"}', { status: 503 }),
      () => new Response('{"refused":"store"}', { status: 500 }),
    ])
      expect(await fetched("k7Qm2xPa", answering(broken))).toEqual({ refused: "down" });
  });

  it("says offline when nothing answers", async () => {
    const nowhere = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await fetched("k7Qm2xPa", nowhere)).toEqual({ refused: "offline" });
  });
});

describe("the server's limits", () => {
  it("are what it says, asked of it alone", async () => {
    const asked: string[] = [];
    const said = await limitsOf((async (url: RequestInfo | URL) => {
      asked.push(String(url));
      return new Response('{"text":524288}');
    }) as typeof fetch);
    expect(said).toEqual({ limits: '{"text":524288}' });
    expect(asked).toEqual(["/api/v1/limits"]);
  });

  it("are refused as the document would be", async () => {
    const slow = () => new Response('{"refused":"slow"}', { status: 429 });
    expect(await limitsOf(answering(slow))).toEqual({ refused: "slow" });
  });
});

describe("a password to a document guessed at from everywhere", () => {
  type Asked = { url: string; password: string | null; work: string | null; body?: string };

  const server = (answers: Response[]) => {
    const asked: Asked[] = [];
    const ask = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      asked.push({
        url: String(url),
        password: headers.get("Tisty-Password"),
        work: headers.get("Tisty-Work"),
        body: init?.body as string | undefined,
      });
      return answers.shift() as Response;
    }) as typeof fetch;
    return { asked, ask };
  };

  const workAsked = () => new Response('{"refused":"work_asked"}', { status: 428 });

  it("works the challenge for that document and says the password again once, with the proof", async () => {
    const { asked, ask } = server([
      workAsked(),
      new Response('{"seed":"s","bits":16}'),
      new Response(new Uint8Array([7])),
    ]);
    const solve = async (challenge: string) => `proof of ${challenge}`;
    const said = await fetched("k7Qm2xPa", ask, "perro azul", solve);
    expect("sealed" in said && said.sealed).toEqual(new Uint8Array([7]));
    expect(asked).toEqual([
      { url: "/api/v1/docs/k7Qm2xPa", password: "cGVycm8gYXp1bA", work: null, body: undefined },
      {
        url: "/api/v1/challenge",
        password: null,
        work: null,
        body: '{"for":"password","id":"k7Qm2xPa"}',
      },
      {
        url: "/api/v1/docs/k7Qm2xPa",
        password: "cGVycm8gYXp1bA",
        work: 'proof of {"seed":"s","bits":16}',
        body: undefined,
      },
    ]);
  });

  it("asks for the password again without saying it when the work cannot be done", async () => {
    const { asked, ask } = server([workAsked(), new Response("{}")]);
    expect(await fetched("k7Qm2xPa", ask, "perro azul", async () => undefined)).toEqual({
      refused: "work_refused",
    });
    expect(asked).toHaveLength(2);
  });

  it("asks for the password again, saying to wait, when the challenge is refused for being too much", async () => {
    const { ask } = server([workAsked(), new Response('{"refused":"slow"}', { status: 429 })]);
    expect(await fetched("k7Qm2xPa", ask, "perro azul", async () => "w")).toEqual({
      refused: "password_locked",
    });
  });

  it("ends the reading when the document went away meanwhile", async () => {
    const { ask } = server([workAsked(), new Response('{"refused":"paused"}', { status: 423 })]);
    expect(await fetched("k7Qm2xPa", ask, "perro azul", async () => "w")).toEqual({
      refused: "paused",
    });
  });

  it("never sends an empty proof", async () => {
    const { asked, ask } = server([workAsked(), new Response("{}")]);
    expect(await fetched("k7Qm2xPa", ask, "perro azul", async () => "")).toEqual({
      refused: "work_refused",
    });
    expect(asked).toHaveLength(2);
  });

  it("is told as it came when the page has no way to work", async () => {
    const { ask } = server([workAsked()]);
    expect(await fetched("k7Qm2xPa", ask, "perro azul")).toEqual({ refused: "work_asked" });
  });
});

describe("a report", () => {
  type Asked = { url: string; method?: string; work: string | null; body?: string };

  const server = (answers: Response[]) => {
    const asked: Asked[] = [];
    const ask = (async (url: RequestInfo | URL, init?: RequestInit) => {
      asked.push({
        url: String(url),
        method: init?.method,
        work: new Headers(init?.headers).get("Tisty-Work"),
        body: init?.body as string | undefined,
      });
      return answers.shift() as Response;
    }) as typeof fetch;
    return { asked, ask };
  };

  it("works the server's challenge and sends the reason and what the reader wrote", async () => {
    const { asked, ask } = server([
      new Response('{"seed":"s","bits":18}'),
      new Response(null, { status: 204 }),
    ]);
    const solve = async (challenge: string) => `proof of ${challenge}`;
    expect(await reported("k7Qm2xPa", "phishing", "Pide mi clave", solve, ask)).toBe("thanked");
    expect(asked).toEqual([
      {
        url: "/api/v1/challenge",
        method: "POST",
        work: null,
        body: '{"for":"report","id":"k7Qm2xPa"}',
      },
      {
        url: "/api/v1/docs/k7Qm2xPa/reports",
        method: "POST",
        work: 'proof of {"seed":"s","bits":18}',
        body: '{"category":"phishing","detail":"Pide mi clave"}',
      },
    ]);
  });

  it("says the server's word when it refuses, and asks nothing more", async () => {
    const twice = server([
      new Response("{}"),
      new Response('{"refused":"reported"}', { status: 409 }),
    ]);
    expect(await reported("k7Qm2xPa", "fraud", "x", async () => "w", twice.ask)).toBe("reported");
    const slow = server([new Response('{"refused":"slow"}', { status: 429 })]);
    expect(await reported("k7Qm2xPa", "fraud", "x", async () => "w", slow.ask)).toBe("slow");
    expect(slow.asked).toHaveLength(1);
  });

  it("fails without asking again when the challenge cannot be worked", async () => {
    const { asked, ask } = server([new Response("{}")]);
    expect(await reported("k7Qm2xPa", "fraud", "x", async () => undefined, ask)).toBe("failed");
    expect(asked).toHaveLength(1);
  });
});

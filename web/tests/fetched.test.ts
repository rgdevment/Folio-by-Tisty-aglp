import { describe, expect, it } from "vitest";
import { fetched, limitsOf } from "../src/fetched";

const answering = (answer: () => Response) => (async () => answer()) as typeof fetch;

describe("what the server answers for a link", () => {
  it("is the sealed bytes", async () => {
    const said = await fetched(
      "k7Qm2xPa",
      answering(() => new Response(new Uint8Array([1, 2, 3]))),
    );
    expect(said).toEqual({ sealed: new Uint8Array([1, 2, 3]) });
  });

  it("asks for the document the link names, and nothing more", async () => {
    const asked: string[] = [];
    await fetched("k7Qm2xPa", (async (url: RequestInfo | URL) => {
      asked.push(String(url));
      return new Response("");
    }) as typeof fetch);
    expect(asked).toEqual(["/api/v1/docs/k7Qm2xPa"]);
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

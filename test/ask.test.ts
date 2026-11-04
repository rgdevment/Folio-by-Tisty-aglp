import { afterEach, describe, expect, it, vi } from "vitest";
import { askFor } from "../src/page/ui/ask";

const ID = "k7Qm2xPa";

const answering = (response: Response | Error) => {
  const fetched = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
};

describe("asking for an envelope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks with nothing of the reader's, and never the key", async () => {
    const fetched = answering(
      new Response(new Uint8Array([1, 2]), { headers: { "Folio-Arrived": "5", "Folio-Dies-On": "7" } }),
    );
    expect(await askFor(ID)).toEqual({ bytes: new Uint8Array([1, 2]), arrivedAt: 5, diesOn: 7 });
    expect(fetched).toHaveBeenCalledWith(`/api/v1/docs/${ID}`, { credentials: "omit", cache: "no-store" });
  });

  it("says what the server refused", async () => {
    answering(new Response(JSON.stringify({ refused: "paused" }), { status: 403 }));
    expect(await askFor(ID)).toEqual({ refused: "paused" });
  });

  it("says when nothing could arrive", async () => {
    answering(new Error("offline"));
    expect(await askFor(ID)).toEqual({ refused: "unreachable" });
  });

  it("says when what came back is not an answer", async () => {
    answering(new Response("<html>", { status: 502 }));
    expect(await askFor(ID)).toEqual({ refused: "unreachable" });
  });
});

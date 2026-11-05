import VECTORS from "@tisty/contracts/vectors.json";
import { describe, expect, it } from "vitest";
import type { Bytes } from "../src/core/bytes";
import { openLink } from "../src/page/read";
import { EnvelopeRefused } from "../src/rules/envelope";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;

const hex = (said: string): Bytes => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));

const ID = "k7Qm2xPa";
const arrivedWith = (envelope: string) => ({ bytes: hex(envelope), arrivedAt: 1_800_000_000_123, diesOn: 21_000 });
const MAIN = arrivedWith(SAMPLES.main.envelope);

const refusalOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "opened",
    (error) => (error instanceof EnvelopeRefused ? error.refusal : `broke: ${error}`),
  );

describe("opening a link", () => {
  it("gives the document, its pictures and what the page says of its signature", async () => {
    const { held, pictures, verdict, fingerprint, diesOn } = await openLink(ID, SAMPLES.link_key, MAIN);
    expect(held.title).toBe("Paseos");
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toEqual(hex(SAMPLES.main.pictures[0]));
    expect(verdict).toBe("holds");
    expect(fingerprint).toBe(SAMPLES.identity.fingerprint);
    expect(diesOn).toBe(21_000);
  });

  it("opens what is public with nothing after the #", async () => {
    const { held } = await openLink("wordsOnly", "", arrivedWith(SAMPLES.public.envelope));
    expect(held.id).toBe("wordsOnly");
  });

  it("asks for the key when it brings none", async () => {
    expect(await refusalOf(openLink(ID, "", MAIN))).toBe("key");
  });

  it("says the link is wrong, and not that the document is damaged", async () => {
    expect(await refusalOf(openLink(ID, "A".repeat(43), MAIN))).toBe("key");
    expect(await refusalOf(openLink(ID, "not*base64", MAIN))).toBe("key");
  });

  it("does not open another document than the one the address names", async () => {
    expect(await refusalOf(openLink("anotherO", SAMPLES.link_key, MAIN))).toBe("damaged");
  });

  it("refuses all the contract refuses", async () => {
    for (const { says, envelope } of SAMPLES.refused) {
      const refused = await refusalOf(openLink("hostile", "", arrivedWith(envelope)));
      expect(["newer", "older", "damaged", "unsigned", "key"], says).toContain(refused);
    }
  });
});

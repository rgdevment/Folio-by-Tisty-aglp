import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdsSignature, newKeys, signedFile } from "../scripts/limits-key";
import { LEVEL_ONE, publishedLimits } from "../src/core/limits";

const said = Buffer.from('{"serial":1}\n');
const NOW = Date.UTC(2026, 10, 6);

describe("a signature of the limits", () => {
  const { secret, publicKey } = newKeys();
  const signature = signedFile(said, "limits.json", secret, NOW);

  it("holds for what it signed, under its key and its name", () => {
    expect(holdsSignature(said, signature, publicKey, "limits.json")).toBe(true);
  });

  it("does not hold for other bytes", () => {
    expect(holdsSignature(Buffer.from('{"serial":2}\n'), signature, publicKey)).toBe(false);
  });

  it("does not hold under another key", () => {
    expect(holdsSignature(said, signature, newKeys().publicKey)).toBe(false);
  });

  it("does not stand in for a file of another name", () => {
    expect(holdsSignature(said, signature, publicKey, "cloud.json")).toBe(false);
  });

  it("does not hold if its signed comment was changed", () => {
    const changed = signature.replace("file:limits.json", "file:limits.json extra");
    expect(holdsSignature(said, changed, publicKey)).toBe(false);
  });

  it("does not take what is not a signature, or not a key", () => {
    expect(holdsSignature(said, "not a signature", publicKey)).toBe(false);
    expect(holdsSignature(said, signature, "not a key")).toBe(false);
  });
});

describe("the limits Folio publishes", () => {
  const file = readFileSync("docs/limits.json");
  const { serial, ...published } = JSON.parse(file.toString()) as { serial: number } & Record<string, unknown>;

  it("are the ones the server holds to", () => {
    const { uploads_halted_until: _halted, ...limits } = published;
    expect(limits).toEqual(publishedLimits(LEVEL_ONE));
    expect(serial).toBeGreaterThan(0);
  });

  it("are signed with the key Tisty is built with", () => {
    const signature = readFileSync("docs/limits.json.minisig", "utf8");
    const publicKey = readFileSync("docs/limits.pub", "utf8");
    expect(holdsSignature(file, signature, publicKey, "limits.json")).toBe(true);
  });

  it("fit in what a reader of a signed file takes", () => {
    expect(file.length).toBeLessThanOrEqual(16 * 1024);
  });
});

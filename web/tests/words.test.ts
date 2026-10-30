import { describe, expect, it } from "vitest";
import { spanish, wordsFor } from "../src/words";

describe("the page's words", () => {
  it("are Spanish when the reader's first language is, and English otherwise, as in Tisty", () => {
    expect(spanish("es-CL")).toBe(true);
    expect(spanish("ES")).toBe(true);
    expect(spanish("en-US")).toBe(false);
    expect(spanish("")).toBe(false);
  });

  it("turn each refusal the server or the envelope gives into a sentence", () => {
    const say = wordsFor(true);
    for (const word of [
      "missing",
      "gone",
      "paused",
      "blocked",
      "locked",
      "keyless",
      "offline",
      "down",
    ])
      expect(say(word), word).not.toBe(say("failed"));
  });

  it("fall back to one plain sentence for a word they do not know", () => {
    for (const word of ["store", "over", "constructor", "toString", "__proto__"])
      expect(wordsFor(false)(word), word).toBe(wordsFor(false)("failed"));
  });

  it("name the callouts as Tisty does", () => {
    expect(wordsFor(true)("saidwarning")).toBe("Aviso");
    expect(wordsFor(false)("saidwarning")).toBe("Warning");
  });
});

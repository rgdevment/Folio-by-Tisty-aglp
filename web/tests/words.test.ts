import { describe, expect, it } from "vitest";
import { REASONS } from "../src/fetched";
import { filled, gated, NOWHERE, refused, spanish, wordsFor } from "../src/words";

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
      "nolink",
      "unwritten",
      "paused",
      "blocked",
      "locked",
      "keyless",
      "offline",
      "down",
      "password_asked",
      "password_wrong",
      "password_locked",
      "reported",
      "thanked",
    ])
      expect(say(word), word).not.toBe(say("failed"));
  });

  it("name every reason a report can give, in both languages", () => {
    for (const inSpanish of [true, false])
      for (const reason of REASONS)
        expect(wordsFor(inSpanish)(`report_${reason}`), reason).not.toBe(
          wordsFor(inSpanish)("failed"),
        );
  });

  it("keep a date where each language puts it", () => {
    expect(filled(wordsFor(true)("shared"), "3 de octubre")).toBe("Compartido el 3 de octubre");
    expect(filled(wordsFor(false)("written"), "2 hours ago")).toBe("edited 2 hours ago");
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

describe("a refusal", () => {
  const answered = (word: string) => {
    const went: string[] = [];
    const told: string[] = [];
    refused(
      word,
      (to) => went.push(to),
      (said) => told.push(said),
    );
    return { went, told };
  };

  it("of a document the server no longer has goes where any missing page goes", () => {
    for (const word of ["missing", "gone"])
      expect(answered(word), word).toEqual({ went: [NOWHERE], told: [] });
  });

  it("of anything else is said on the page, a badly copied link and one still uploading too", () => {
    for (const word of ["nolink", "unwritten", "paused", "blocked", "keyless", "locked", "down"])
      expect(answered(word), word).toEqual({ went: [], told: [word] });
  });

  it("about the password is answered by saying it, and no other is", () => {
    for (const word of ["password_asked", "password_wrong", "password_locked"])
      expect(gated(word), word).toBe(true);
    for (const word of ["missing", "locked", "keyless", "forbidden"])
      expect(gated(word), word).toBe(false);
  });
});

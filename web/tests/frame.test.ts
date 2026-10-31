import { describe, expect, it } from "vitest";
import {
  accessOf,
  bylined,
  endsOf,
  type Signed,
  sealOf,
  tagged,
  tistyOf,
  whenOf,
} from "../src/frame";
import { day } from "../src/when";
import { wordsFor } from "../src/words";

const say = wordsFor(true);
const NOW = 1_793_361_600;
const DAY = 86_400;

const mario: Signed = { is: "holds", fingerprint: "12345 67890 12345 67890" };
const ana: Signed = { is: "holds", fingerprint: "99999 88888 77777 66666" };

describe("when it was shared", () => {
  const facts = { shared: NOW - 3 * DAY, written: NOW - 3 * 3_600, gated: false };

  it("says the day it was shared and how long ago it was edited", () => {
    expect(whenOf(facts, 2, NOW, "es", say)).toBe(
      "Compartido el 27 de octubre de 2026 · editado hace 3 horas",
    );
  });

  it("calls no first version edited, since it was written when it was shared", () => {
    expect(whenOf(facts, 1, NOW, "es", say)).toBe("Compartido el 27 de octubre de 2026");
  });

  it("says nothing the server did not tell", () => {
    expect(whenOf({ gated: false }, 3, NOW, "es", say)).toBe("");
  });
});

describe("the seal", () => {
  it("names the writer by their whole fingerprint, never by the short suffix anyone can forge", () => {
    expect(sealOf({ wrote: mario, sent: mario }, "es")).toEqual({
      verdict: "holds",
      fingerprint: mario.fingerprint,
      sender: undefined,
    });
  });

  it("shows the name and the day the writer signed with, never the uploader's", () => {
    const named: Signed = { ...mario, name: "Mario Hidalgo", signed: NOW } as Signed;
    expect(sealOf({ wrote: named, sent: { ...ana, name: "Ana" } as Signed }, "es")).toMatchObject({
      name: "Mario Hidalgo",
      signedOn: day(NOW, "es"),
      sender: ana.fingerprint,
    });
    expect(sealOf({ wrote: mario }, "es")).toMatchObject({ name: undefined, signedOn: undefined });
  });

  it("names who uploaded it only when it was someone else", () => {
    expect(sealOf({ wrote: mario, sent: ana }, "es").sender).toBe(ana.fingerprint);
  });

  it("says when nobody signed it, or the signature does not hold", () => {
    expect(sealOf({}, "es")).toEqual({ verdict: "unsigned" });
    expect(sealOf({ sent: ana }, "es")).toEqual({ verdict: "unsigned" });
    expect(sealOf({ wrote: { is: "refused" } }, "es")).toMatchObject({
      verdict: "refused",
      fingerprint: undefined,
    });
  });
});

describe("what the side says", () => {
  it("names who can open it", () => {
    expect(say(accessOf({ gated: false }))).toBe("Solo con el link");
    expect(say(accessOf({ gated: true }))).toBe("Con el link y una clave");
  });

  it("gives the day it ends, short enough to sit beside its name", () => {
    expect(endsOf({ ends: NOW + 30 * DAY, gated: false }, "es")).toBe("29 nov 2026");
    expect(endsOf({ ends: NOW + 30 * DAY, gated: false }, "en")).toBe("Nov 29, 2026");
    expect(endsOf({ gated: false }, "es")).toBe("");
  });
});

describe("the byline", () => {
  const pageOf = (html: string): Document => {
    const page = document.implementation.createHTMLDocument("");
    page.body.innerHTML = `<article class="page">${html}</article>`;
    return page;
  };

  it("sits right after the body's title, with its tags and dates, and leaves the rest alone", () => {
    const page = pageOf("<h1>Guía</h1><p>Texto</p>");
    expect(bylined(page, ["guía"], "Compartido hoy")).toBe(true);
    const blocks = [...(page.querySelector(".page")?.children ?? [])];
    expect(blocks.map((one) => one.className || one.tagName)).toEqual(["H1", "byline", "P"]);
    expect(blocks[1].textContent).toBe("#guíaCompartido hoy");
    expect(page.head.querySelector("style")?.textContent).toContain(".byline");
  });

  it("is left to the frame when the body has no title, or there is nothing to say", () => {
    expect(bylined(pageOf("<figure class='code'><pre>x</pre></figure>"), ["a"], "hoy")).toBe(false);
    expect(bylined(pageOf("<h1>Guía</h1>"), [], "")).toBe(false);
  });
});

describe("opening it in Tisty", () => {
  it("hands Tisty the whole link, key and all", () => {
    expect(tistyOf("https://tisty.cl/k7Qm2xPa#clave+/=")).toBe(
      "tisty://share?link=https%3A%2F%2Ftisty.cl%2Fk7Qm2xPa%23clave%2B%2F%3D",
    );
  });
});

describe("the tags", () => {
  it("are shown above the body, and the row hides when there are none", () => {
    const row = document.createElement("p");
    tagged(row, ["guía", "docker"]);
    expect([...row.children].map((one) => one.textContent)).toEqual(["#guía", "#docker"]);
    expect(row.hidden).toBe(false);
    tagged(row, []);
    expect(row.children).toHaveLength(0);
    expect(row.hidden).toBe(true);
  });
});

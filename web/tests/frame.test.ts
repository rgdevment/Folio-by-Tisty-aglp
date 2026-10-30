import { describe, expect, it } from "vitest";
import {
  accessOf,
  authored,
  bylined,
  endsOf,
  fileOf,
  type Seal,
  type Signed,
  sealed,
  sealOf,
  tagged,
  tistyOf,
  whenOf,
} from "../src/frame";
import { wordsFor } from "../src/words";

const say = wordsFor(true);
const NOW = 1_793_361_600;
const DAY = 86_400;

const mario: Signed = { is: "holds", fingerprint: "12345 67890 12345 67890", suffix: "r8f1" };
const ana: Signed = { is: "holds", fingerprint: "99999 88888 77777 66666", suffix: "k7qp" };

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
  it("names who wrote it and their fingerprint", () => {
    expect(sealOf({ wrote: mario, sent: mario })).toEqual({
      verdict: "holds",
      who: "r8f1",
      fingerprint: mario.fingerprint,
      sender: undefined,
    });
  });

  it("names who uploaded it only when it was someone else", () => {
    expect(sealOf({ wrote: mario, sent: ana }).sender).toBe("k7qp");
    expect(sealOf({ sent: ana })).toMatchObject({ verdict: "holds", who: "k7qp" });
  });

  it("says when nobody signed it, or the signature does not hold", () => {
    expect(sealOf({})).toEqual({ verdict: "unsigned" });
    expect(sealOf({ wrote: { is: "refused" } })).toMatchObject({
      verdict: "refused",
      who: undefined,
    });
  });

  it("is drawn with its verdict, and without a print it does not have", () => {
    const box = document.createElement("section");
    box.hidden = true;
    box.innerHTML =
      '<span class="seal-who"></span><code class="seal-print"></code><span class="seal-verdict"></span><span class="seal-sender"></span>';
    const drawnAs = (seal: Seal) => {
      sealed(box, seal, say);
      return [...box.children].map((one) => one.textContent);
    };
    expect(drawnAs(sealOf({ wrote: mario, sent: ana }))).toEqual([
      "Firmado por r8f1",
      mario.fingerprint,
      "Firma válida",
      "Subido por k7qp",
    ]);
    expect(box.dataset.verdict).toBe("holds");
    expect(box.hidden).toBe(false);
    drawnAs({ verdict: "unsigned" });
    expect(box.querySelector<HTMLElement>(".seal-print")?.hidden).toBe(true);
    expect(box.dataset.verdict).toBe("unsigned");
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

describe("the author's card", () => {
  const card = () => {
    const made = document.createElement("section");
    made.innerHTML =
      '<span class="avatar"></span><span class="author-who"></span><span class="author-print"></span><span class="author-said"></span>';
    return made;
  };
  const text = (made: HTMLElement) => [...made.children].map((one) => one.textContent);

  it("names who signed it and says the signature matches their key", () => {
    const made = card();
    authored(made, sealOf({ wrote: mario }), say);
    expect(text(made)).toEqual([
      "R8",
      "r8f1",
      mario.fingerprint,
      "La firma coincide con esta llave",
    ]);
    expect(made.hidden).toBe(false);
    expect(made.dataset.verdict).toBe("holds");
  });

  it("warns when the key was revoked, and is not there when nobody can be named", () => {
    const made = card();
    authored(made, sealOf({ wrote: { ...mario, is: "revoked" } }), say);
    expect(text(made)[3]).toBe(say("revoked"));
    authored(made, sealOf({}), say);
    expect(made.hidden).toBe(true);
    authored(made, sealOf({ wrote: { is: "unreadable" } }), say);
    expect(made.hidden).toBe(true);
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

describe("the downloaded file", () => {
  it("is named after the title, without what some systems forbid", () => {
    expect(fileOf("Docker: guía/rápida?", "Documento")).toBe("Docker guíarápida.md");
    expect(fileOf("  ", "Documento compartido")).toBe("Documento compartido.md");
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

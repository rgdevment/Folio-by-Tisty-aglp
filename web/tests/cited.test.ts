import { carded } from "tisty-editor/read";
import { describe, expect, it, vi } from "vitest";
import {
  type Cited,
  cardOf,
  citedAt,
  citedOf,
  citedOpening,
  citedWord,
  citing,
  walking,
} from "../src/cited";
import { sheetWordsFor } from "../src/words";

const PAGE: Cited = { doc: "d2", id: "Pg2xYz34", key: "llave2", title: "Instalar", page: [2, 3] };
const GUIDE: Cited = { doc: "d9", id: "Gd9xYz34", key: "llave9", title: "Glosario" };
const CITED = [PAGE, GUIDE];

const pageOf = (html: string): Document => {
  const page = document.implementation.createHTMLDocument("");
  page.body.innerHTML = `<article class="page">${html}</article>`;
  return page;
};

const card = (doc: string, title: string) =>
  `<p><a class="card" data-doc="${doc}">${title}</a></p>`;

describe("what a document cites", () => {
  it("is read from the list sealed with it, a page with its place and a document without one", () => {
    expect(citedOf(JSON.stringify(CITED))).toEqual(CITED);
  });

  it("leaves out an entry that does not read, and a list that does not read is empty", () => {
    const list = [
      GUIDE,
      { ...GUIDE, key: 5 },
      { ...PAGE, page: [2] },
      { ...PAGE, page: ["2", "3"] },
      null,
    ];
    expect(citedOf(JSON.stringify(list))).toEqual([GUIDE]);
    for (const bad of ["", "{", "{}", '"d2"']) expect(citedOf(bad), bad).toEqual([]);
  });
});

describe("a card in the sheet", () => {
  it("names a page of the document with its place, counted from one", () => {
    expect(cardOf(CITED)("d2")).toEqual({ kind: "page", title: "Instalar", at: 2, of: 3 });
  });

  it("names a cited document as a document", () => {
    expect(cardOf(CITED)("d9")).toEqual({ kind: "doc", title: "Glosario" });
  });

  it("names one the document did not carry as not shared with it", () => {
    expect(cardOf(CITED)("d7")).toEqual({ kind: "gone" });
    expect(cardOf([])("d2")).toEqual({ kind: "gone" });
  });

  it("is drawn by the sheet as Tisty draws it, a page saying which it is", () => {
    const page = pageOf(card("d2", "Instalar") + card("d7", "Borrador"));
    carded(page, { card: cardOf(CITED), say: sheetWordsFor(true) }, () => true);
    const [one, gone] = page.querySelectorAll<HTMLElement>(".doc-card");
    expect(one.querySelector(".chip")?.textContent).toBe("Página 2 de 3");
    expect(one.dataset.doc).toBe("d2");
    expect(gone.dataset.doc).toBeUndefined();
    expect(gone.querySelector(".card-blurb")?.textContent).toBe(
      "Ese documento no se compartió con este",
    );
  });
});

describe("a click on a card", () => {
  const clicked = (html: string, selector: string) => {
    const page = pageOf(html);
    carded(page, { card: cardOf(CITED), say: sheetWordsFor(false) }, () => true);
    const opened = vi.fn();
    citing(page, CITED, opened);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    page.querySelector(selector)?.dispatchEvent(event);
    return { opened, stopped: event.defaultPrevented };
  };

  it("on a cited document opens it, from anywhere on the card", () => {
    const { opened, stopped } = clicked(card("d9", "Glosario"), ".doc-card .card-name");
    expect(opened).toHaveBeenCalledWith(GUIDE);
    expect(stopped).toBe(true);
  });

  it("on a card inside a sentence opens it too", () => {
    const { opened } = clicked('<p>Ver <a class="card" data-doc="d2">Instalar</a> antes.</p>', "a");
    expect(opened).toHaveBeenCalledWith(PAGE);
  });

  it("on one not shared with it opens nothing", () => {
    const { opened, stopped } = clicked(card("d7", "Borrador"), ".doc-card");
    expect(opened).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
  });

  it("anywhere else is no card", () => {
    expect(citedAt(pageOf("<p>Hola</p>").querySelector("p"), CITED)).toBeUndefined();
    expect(citedAt(null, CITED)).toBeUndefined();
  });
});

const sealed = (status = 200, body: BodyInit = new Uint8Array([7])) =>
  new Response(body, { status, headers: { "Tisty-Shared": "1793000000" } });

const opening = (answer: () => Response) => {
  const asked: [string, string | null][] = [];
  const ask = (async (url: RequestInfo | URL, init?: RequestInit) => {
    asked.push([String(url), new Headers(init?.headers).get("Tisty-Password")]);
    return answer();
  }) as typeof fetch;
  const read = vi.fn(async (one: Cited, answer: { sealed: Uint8Array }) => ({
    key: one.key,
    bytes: [...answer.sealed],
  }));
  return { asked, read, open: citedOpening(read, ask) };
};

describe("a cited document", () => {
  it("is asked for by its own id, with no password, and opened by its own key", async () => {
    const { asked, read, open } = opening(() => sealed());
    expect(await open(GUIDE)).toEqual({ key: "llave9", bytes: [7] });
    expect(asked).toEqual([["/api/v1/docs/Gd9xYz34", null]]);
    expect(read.mock.calls[0][1]).toMatchObject({ facts: { shared: 1_793_000_000 } });
  });

  it("is asked for once for the page's life, however many times it is opened", async () => {
    const { asked, open } = opening(() => sealed());
    await open(GUIDE);
    await open(GUIDE);
    await open(PAGE);
    expect(asked.map(([url]) => url)).toEqual(["/api/v1/docs/Gd9xYz34", "/api/v1/docs/Pg2xYz34"]);
  });

  it("is asked for again once forgotten, as when what followed its sheet went stale", async () => {
    const { asked, open } = opening(() => sealed());
    await open(GUIDE);
    open.forget(GUIDE.id);
    await open(GUIDE);
    expect(asked).toHaveLength(2);
  });

  it("the server no longer has is said in place, and asked for again the next time", async () => {
    const { asked, read, open } = opening(() => sealed(404, '{"refused":"gone"}'));
    expect(await open(GUIDE)).toBe("citedGone");
    expect(await open(GUIDE)).toBe("citedGone");
    expect(asked).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
  });

  it("that its envelope refuses says why, as the shared one would", async () => {
    const asked = (async () => sealed()) as typeof fetch;
    const open = citedOpening(async () => "locked", asked);
    expect(await open(GUIDE)).toBe("locked");
  });
});

describe("a refusal for a cited document", () => {
  it("never leaves the page nor asks a password", () => {
    expect(citedWord("missing")).toBe("citedGone");
    expect(citedWord("gone")).toBe("citedGone");
    for (const word of ["password_asked", "password_wrong", "password_locked", "work_refused"])
      expect(citedWord(word), word).toBe("failed");
  });

  it("says the rest as the page says them", () => {
    for (const word of ["paused", "blocked", "offline", "down", "unsigned", "forged"])
      expect(citedWord(word), word).toBe(word);
  });
});

const steps = () => ({ pushState: vi.fn(), go: vi.fn() });

describe("the way through cited documents", () => {
  it("starts at the shared document, with nowhere to go back to", () => {
    const walk = walking<Cited | null>(null, steps(), vi.fn());
    expect(walk.at()).toBe(0);
    expect(walk.deep()).toBe(false);
  });

  it("goes into a cited one with a step of the browser's own, which keeps only its place", () => {
    const history = steps();
    const show = vi.fn();
    const walk = walking<Cited | null>(null, history, show);
    walk.went(GUIDE);
    walk.went(PAGE);
    expect(history.pushState.mock.calls).toEqual([
      [{ at: 1 }, ""],
      [{ at: 2 }, ""],
    ]);
    expect(show.mock.calls).toEqual([
      [GUIDE, 1],
      [PAGE, 2],
    ]);
    expect(walk.deep()).toBe(true);
  });

  it("goes up to the step it hangs from through the browser's history, however many steps away", () => {
    const history = steps();
    const show = vi.fn();
    const walk = walking<Cited | null>(null, history, show);
    walk.went(GUIDE);
    walk.went(PAGE);
    walk.up(0);
    expect(history.go).toHaveBeenCalledWith(-2);
    walk.popped({ at: 0 });
    expect(show).toHaveBeenLastCalledWith(null, 0);
    expect(walk.deep()).toBe(false);
  });

  it("goes forward again to what it came back from", () => {
    const show = vi.fn();
    const walk = walking<Cited | null>(null, steps(), show);
    walk.went(GUIDE);
    walk.popped(null);
    walk.popped({ at: 1 });
    expect(show).toHaveBeenLastCalledWith(GUIDE, 1);
  });

  it("forgets what lay ahead once another card is opened from further back", () => {
    const show = vi.fn();
    const walk = walking<Cited | null>(null, steps(), show);
    walk.went(GUIDE);
    walk.popped({ at: 0 });
    walk.went(PAGE);
    walk.popped({ at: 1 });
    expect(show).toHaveBeenLastCalledWith(PAGE, 1);
  });

  it("takes a step a reload forgot straight back to the shared document's own entry", () => {
    const show = vi.fn();
    const history = steps();
    const walk = walking<Cited | null>(null, history, show);
    walk.popped({ at: 3 });
    expect(history.go).toHaveBeenCalledWith(-3);
    expect(show).not.toHaveBeenCalled();
    for (const state of [{ at: -1 }, { at: "1" }, "x"]) walk.popped(state);
    expect(show.mock.calls.every(([one, at]) => one === null && at === 0)).toBe(true);
  });

  it("keeps the way back on a cited document the server refused, said in the page", async () => {
    const { open } = opening(() => sealed(404, '{"refused":"missing"}'));
    const said: string[] = [];
    const walk = walking<Cited | null>(null, steps(), (one) => {
      if (one) open(one).then((found) => said.push(String(found)));
    });
    walk.went(GUIDE);
    await vi.waitFor(() => expect(said).toEqual(["citedGone"]));
    expect(walk.deep()).toBe(true);
  });
});

import { type Panel, sided } from "tisty-editor/read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Asked, falling, GET_TISTY, type Now, panelsOf, signedApart } from "../src/beside";
import type { View } from "../src/drawn";
import { wordsFor } from "../src/words";

const say = wordsFor(true);
const words = { sheet: (word: string) => word, page: say, language: "es" };
const LINK = "https://tisty.cl/AbCd1234#llave";
const LINKS = { opened: `${LINK}.token`, read: LINK };

const now = (more: Partial<Now> = {}): Now => ({
  title: "Guía",
  text: "# Guía\n\nHola",
  about: {},
  facts: { gated: false },
  view: { leaf: "a4", sheets: false, landscape: false },
  raw: false,
  heads: [],
  ...more,
});

const asking = () => {
  const views: View[] = [];
  const asked: Asked = { onView: (view) => views.push(view), onRaw: vi.fn(), onShut: vi.fn() };
  return { asked, views };
};

const of = <K extends Panel["kind"]>(panels: Panel[], kind: K) =>
  panels.find((one) => one.kind === kind) as Extract<Panel, { kind: K }>;

afterEach(() => vi.unstubAllGlobals());

describe("the panels beside a shared document", () => {
  it("are the reader's: what it is, its paper and outline, its details and signature, and what can be done", () => {
    const { asked } = asking();
    const panels = panelsOf(now(), asked, words, LINKS);
    expect(panels.map((one) => one.kind)).toEqual([
      "title",
      "paper",
      "index",
      "details",
      "seal",
      "acts",
    ]);
    expect(of(panels, "title").title).toBe("Guía");
    expect(of(panels, "seal").seal.verdict).toBe("unsigned");
    expect(of(panels, "title").onShut).toBe(asked.onShut);
  });

  it("leave out what needs the text while it travels after the sheet: its Markdown, its raw view and its size", () => {
    const panels = panelsOf(now({ text: undefined }), asking().asked, words, LINKS);
    expect(of(panels, "acts").acts.map((one) => one.key)).toEqual(["open", "copy"]);
    expect(of(panels, "paper").raw).toBeUndefined();
    const { body, weighs } = of(panels, "details").facts;
    expect([body, weighs]).toEqual([undefined, undefined]);
  });

  it("names a body without a title by the page's word", () => {
    const panels = panelsOf(now({ title: "" }), asking().asked, words, LINKS);
    expect(of(panels, "title").title).toBe(say("document"));
  });

  it("changes the paper from the view it shows, and offers landscape only while the sheets are laid", () => {
    const { asked, views } = asking();
    const flat = of(panelsOf(now(), asked, words, LINKS), "paper");
    expect(flat.landscape).toBeUndefined();
    flat.onLeaf("letter");
    flat.sheets?.onTurn(true);
    const laid = of(
      panelsOf(now({ view: { leaf: "a4", sheets: true, landscape: false } }), asked, words, LINKS),
      "paper",
    );
    laid.landscape?.onTurn(true);
    expect(views).toEqual([
      { leaf: "letter", sheets: false, landscape: false },
      { leaf: "a4", sheets: true, landscape: false },
      { leaf: "a4", sheets: true, landscape: true },
    ]);
  });

  it("opens in Tisty with the whole link, copies the text as it is, and copies the link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const acts = of(panelsOf(now(), asking().asked, words, LINKS), "acts").acts;
    const [open, md, copy] = acts;
    expect(open).toMatchObject({
      main: true,
      href: `tisty://share?link=${encodeURIComponent(LINKS.opened)}`,
    });
    const copiedText = document.createElement("button");
    md.onPick?.(copiedText);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(now().text);
    expect(copiedText.textContent).toBe(say("copiedmd"));
    const button = document.createElement("button");
    copy.onPick?.(button);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(button.textContent).toBe(say("copied"));
  });
});

describe("opening in Tisty", () => {
  afterEach(() => vi.useRealTimers());

  it("offers Tisty instead when the page is still in front a moment later", () => {
    vi.useFakeTimers();
    const link = document.createElement("a");
    link.href = "tisty://share?link=x";
    link.textContent = "Abrir en Tisty";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    falling("¿No se abrió? Descarga Tisty")(link);
    vi.advanceTimersByTime(1500);
    expect(link.textContent).toBe("¿No se abrió? Descarga Tisty");
    expect(link.getAttribute("href")).toBe(GET_TISTY);
  });

  it("leaves the link as it was when Tisty took the page's place", () => {
    vi.useFakeTimers();
    const link = document.createElement("a");
    link.href = "tisty://share?link=x";
    link.textContent = "Abrir en Tisty";
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    falling("¿No se abrió? Descarga Tisty")(link);
    vi.advanceTimersByTime(1500);
    expect(link.textContent).toBe("Abrir en Tisty");
  });
});

describe("a cited document signed by another key", () => {
  const drawnFor = (about: Now["about"]) => {
    const host = document.createElement("div");
    sided(host, (word) => word, panelsOf(now({ about }), asking().asked, words, LINKS));
    return host;
  };
  const signed = { wrote: { is: "holds", fingerprint: "99999 88888" } } as const;

  it("says so in its signature, open so it is read", () => {
    const host = drawnFor(signed);
    signedApart(host, say("otherWriter"));
    const row = host.querySelector<HTMLDetailsElement>('details[data-row="seal"]');
    expect(row?.open).toBe(true);
    expect(row?.querySelector(".side-row-body")?.lastElementChild?.textContent).toBe(
      say("otherWriter"),
    );
  });

  it("stays shut when the reader shut it", () => {
    const host = drawnFor(signed);
    const row = host.querySelector<HTMLDetailsElement>('details[data-row="seal"]');
    if (row) row.dataset.chosen = "";
    signedApart(host, say("otherWriter"));
    expect(row?.open).toBe(false);
  });

  it("says nothing where there is no signature to speak of", () => {
    const host = drawnFor({});
    signedApart(host, say("otherWriter"));
    expect(host.textContent).not.toContain(say("otherWriter"));
  });

  it("says in its details who signed it, when it was shared and edited, and its size, as the window does", () => {
    const { asked } = asking();
    const details = of(
      panelsOf(
        now({
          text: "ñandú",
          about: { wrote: { is: "holds", fingerprint: "ABCD", name: "Ana" } },
          facts: { shared: 1_800_000_000, written: 1_800_086_400, gated: false },
        }),
        asked,
        words,
        LINKS,
      ),
      "details",
    );
    expect(details.facts.author).toBe("Ana");
    expect(details.facts.made).toMatch(/\d/);
    expect(details.facts.wrote).not.toBe(details.facts.made);
    // Counted in bytes as the file takes them, so «ñ» and «ú» weigh two each.
    expect(details.facts.weighs).toBe("7 B");
  });
});

import type { Panel } from "tisty-editor/read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Asked, type Now, panelsOf } from "../src/beside";
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

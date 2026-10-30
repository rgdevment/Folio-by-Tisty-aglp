import type { Panel } from "tisty-editor/read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Asked, type Now, panelsOf } from "../src/beside";
import type { View } from "../src/drawn";
import { wordsFor } from "../src/words";

const say = wordsFor(true);
const words = { sheet: (word: string) => word, page: say };
const LINK = "https://tisty.cl/AbCd1234#llave";

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
    const panels = panelsOf(now(), asked, words, LINK);
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
    const panels = panelsOf(now({ title: "" }), asking().asked, words, LINK);
    expect(of(panels, "title").title).toBe(say("document"));
  });

  it("changes the paper from the view it shows, and offers landscape only while the sheets are laid", () => {
    const { asked, views } = asking();
    const flat = of(panelsOf(now(), asked, words, LINK), "paper");
    expect(flat.landscape).toBeUndefined();
    flat.onLeaf("letter");
    flat.sheets?.onTurn(true);
    const laid = of(
      panelsOf(now({ view: { leaf: "a4", sheets: true, landscape: false } }), asked, words, LINK),
      "paper",
    );
    laid.landscape?.onTurn(true);
    expect(views).toEqual([
      { leaf: "letter", sheets: false, landscape: false },
      { leaf: "a4", sheets: true, landscape: false },
      { leaf: "a4", sheets: true, landscape: true },
    ]);
  });

  it("opens in Tisty with the whole link, downloads the text as it is, and copies the link", async () => {
    const made = vi.fn(() => "blob:texto");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: made, revokeObjectURL: vi.fn() }));
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const acts = of(panelsOf(now(), asking().asked, words, LINK), "acts").acts;
    const [open, md, copy] = acts;
    expect(open).toMatchObject({
      main: true,
      href: `tisty://share?link=${encodeURIComponent(LINK)}`,
    });
    expect(md.download).toBe("Guía.md");
    const link = document.createElement("a");
    link.href = "#";
    md.onPick?.(link);
    expect(link.href).toBe("blob:texto");
    const button = document.createElement("button");
    copy.onPick?.(button);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(button.textContent).toBe(say("copied"));
  });
});

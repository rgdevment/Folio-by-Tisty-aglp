import { describe, expect, it, vi } from "vitest";
import type { Cited } from "../src/cited";
import { onward, placedIn, type Ribboned, ribbon } from "../src/ribbon";

const page = (at: number, id: string): Cited => ({
  doc: id,
  id,
  key: "k",
  title: `Página ${id}`,
  page: [at, 3],
});
const ONE = page(1, "uno");
const TWO = page(2, "dos");
const THREE = page(3, "tres");
const CITED: Cited = { doc: "otro", id: "otro", key: "k", title: "Otro" };

const words: Ribboned = {
  whereThisSits: "Dónde está esta página",
  leafBack: "Página anterior",
  leafOn: "Página siguiente",
  leafNext: "Siguiente",
  leafOfMany: (at, of) => `Página ${at} de ${of}`,
};

describe("where a document opened from another sits", () => {
  it("is a page among its sisters in the order they run, whatever order the list holds them in", () => {
    const placed = placedIn(TWO, "Guía", [THREE, CITED, ONE, TWO]);
    expect(placed).toEqual({ up: "Guía", at: [2, 3], back: ONE, on: THREE });
    expect(placedIn(ONE, "Guía", [THREE, ONE, TWO]).back).toBeUndefined();
    expect(placedIn(THREE, "Guía", [THREE, ONE, TWO]).on).toBeUndefined();
  });

  it("is only the document above when it is no page", () => {
    expect(placedIn(CITED, "Guía", [CITED, ONE])).toEqual({ up: "Guía" });
  });
});

describe("the bar over the sheet", () => {
  it("goes up to the document above, and to a page's sisters from its arrows", () => {
    const bar = document.createElement("nav");
    const up = vi.fn();
    const to = vi.fn();
    ribbon(bar, placedIn(ONE, "Guía", [ONE, TWO, THREE]), words, { up, to });

    expect(bar.hidden).toBe(false);
    expect(bar.querySelector(".ribbon-up")?.textContent).toBe("Guía");
    expect(bar.querySelector(".ribbon-at")?.textContent).toBe("Página 1 de 3");
    const [before, after] = bar.querySelectorAll<HTMLButtonElement>(".ribbon-arrows button");
    expect(before.disabled).toBe(true);
    after.click();
    expect(to).toHaveBeenCalledWith(TWO);
    bar.querySelector<HTMLButtonElement>(".ribbon-back")?.click();
    expect(up).toHaveBeenCalledOnce();
  });

  it("is hidden on the shared document itself", () => {
    const bar = document.createElement("nav");
    ribbon(bar, null, words, { up: vi.fn(), to: vi.fn() });
    expect(bar.hidden).toBe(true);
    expect(bar.childElementCount).toBe(0);
  });
});

describe("the page that comes next", () => {
  it("is offered under the sheet, and only while there is one", () => {
    const under = document.createElement("button");
    const go = vi.fn();
    onward(under, TWO, words, go);
    expect(under.hidden).toBe(false);
    expect(under.querySelector(".onward-name")?.textContent).toBe("Página dos");
    under.click();
    expect(go).toHaveBeenCalledWith(TWO);

    onward(under, undefined, words, go);
    expect(under.hidden).toBe(true);
  });
});

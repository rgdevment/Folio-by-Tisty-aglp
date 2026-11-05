import { readFileSync } from "node:fs";
import type { Document } from "@tisty/contracts";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domPurifyCleaner } from "../src/page/ui/clean";
import { finished } from "../src/page/ui/finish";
import { drawFrame } from "../src/page/ui/frame";

const SEAL = { verdict: "holds", fingerprint: "1", diesOn: "mañana" } as const;
const ADDRESS = "https://tisty.cl/k7Qm2xPa#THEKEY";

const HELD: Document = {
  id: "k7Qm2xPa",
  title: "Paseos",
  body: "",
  html: [
    '<h1 id="paseos">Paseos</h1>',
    '<p><a href="#rio">río</a> <a href="tisty:page/1">Enero</a></p>',
    '<p><a href="tisty:cited/0">otro</a> <a href="tisty:file/0">adjunto</a></p>',
    '<p><a href="https://www.tisty.app/">web</a></p>',
    '<h2 id="rio">Río</h2>',
  ].join(""),
  pages: [{ id: "p1", page_of: "k7Qm2xPa", at: 1, title: "Enero", html: '<h1 id="enero">Enero</h1>', body: "" }],
  cited: [{ document: "wordsOnly", key: "CITEDKEY" }],
};

let root: ShadowRoot;
let scrolled: Element[];
let assign: ReturnType<typeof vi.fn>;
let place: Window & typeof globalThis;

const linkSaying = (words: string): Element | undefined =>
  [...root.querySelectorAll("a")].find((one) => one.textContent === words);

const click = (words: string): boolean => {
  const event = new place.MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
  // Read as it reaches the page, and stopped there: jsdom cannot follow a link anyway.
  let prevented = false;
  place.document.addEventListener(
    "click",
    (seen: Event) => {
      prevented = seen.defaultPrevented;
      seen.preventDefault();
    },
    { once: true },
  );
  linkSaying(words)?.dispatchEvent(event);
  return prevented;
};

const draw = (held: Document): void => {
  const cleaner = domPurifyCleaner(place);
  drawFrame(held, (html) => finished(cleaner.clean(html), []), SEAL);
};

beforeEach(() => {
  const dom = new JSDOM(readFileSync("src/page/index.html", "utf8"), { url: ADDRESS });
  place = dom.window;
  scrolled = [];
  assign = vi.fn();
  const attach = place.Element.prototype.attachShadow;
  place.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    root = attach.call(this, init);
    return root;
  };
  place.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("document", place.document);
  vi.stubGlobal("location", { href: ADDRESS, hash: "#THEKEY", assign });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a click on what the sheet links to", () => {
  it("moves to a heading without touching the address, since what follows its # is the key", () => {
    draw(HELD);
    expect(click("río")).toBe(true);
    expect(scrolled.map((one) => one.id)).toEqual(["rio"]);
    expect(place.location.href).toBe(ADDRESS);
    expect(assign).not.toHaveBeenCalled();
  });

  it("turns to a page, and marks it", () => {
    draw(HELD);
    expect(click("Enero")).toBe(true);
    expect(place.document.title).toBe("Enero · Folio");
    expect(root.querySelector("h1")?.id).toBe("enero");
    const marks = [...place.document.querySelectorAll("#pages button")].map((one) => one.getAttribute("aria-current"));
    expect(marks).toEqual(["page"]);
    expect(place.location.href).toBe(ADDRESS);
  });

  it("shows the way back above a page, and none above the document", () => {
    const crumb = () => place.document.getElementById("crumb");
    draw(HELD);
    expect(crumb()?.hidden).toBe(true);
    click("Enero");
    expect(crumb()?.hidden).toBe(false);
    expect(place.document.getElementById("crumb-at")?.textContent).toBe("Página 1 de 1");
    place.document.getElementById("crumb-back")?.click();
    expect(crumb()?.hidden).toBe(true);
    expect(place.document.title).toBe(`${HELD.title} · Folio`);
  });

  it("goes to what is cited, with its own key", () => {
    draw(HELD);
    expect(click("otro")).toBe(true);
    expect(assign).toHaveBeenCalledWith("/wordsOnly#CITEDKEY");
  });

  it("does nothing with a file, which no longer looks like a link", () => {
    draw(HELD);
    expect(linkSaying("adjunto")?.hasAttribute("href")).toBe(false);
    expect(click("adjunto")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves what goes elsewhere to the browser, in another tab", () => {
    draw(HELD);
    expect(click("web")).toBe(false);
    expect(linkSaying("web")?.getAttribute("target")).toBe("_blank");
  });
});

describe("the index", () => {
  const dockButton = () => place.document.querySelector<HTMLElement>('.dock [data-panel="panel-index"]');
  const panel = () => place.document.getElementById("panel-index");

  it("stays offered when there is something in it", () => {
    draw(HELD);
    expect(panel()?.hidden).toBe(false);
    expect(dockButton()?.hidden).toBe(false);
  });

  it("is not offered on the dock when it has nothing to show", () => {
    draw({ id: "k7Qm2xPa", title: "Solo", body: "", html: "<p>Sin títulos.</p>" });
    expect(panel()?.hidden).toBe(true);
    expect(dockButton()?.hidden).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedOut, linkedWithin, pictured, placeOf, plain, titleOf, unasked } from "../src/drawn";

const pageOf = (html: string): Document => {
  const page = document.implementation.createHTMLDocument("");
  page.body.innerHTML = `<article class="page">${html}</article>`;
  return page;
};

const png = { bytes: new Uint8Array([137, 80, 78, 71]), media: "image/png" };

afterEach(() => vi.unstubAllGlobals());

describe("a picture the text names", () => {
  it("is set aside before the frame reads it, so the browser never asks for it", () => {
    const html = '<p><img src="tisty:picture/0" alt="Uno"><img src="https://x.test/a.png"></p>';
    expect(unasked(html)).toBe(
      '<p><img data-picture="0" alt="Uno"><img src="https://x.test/a.png"></p>',
    );
  });

  it("shows its own bytes, from the envelope, by its place", () => {
    const made: Blob[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: Blob) => {
        made.push(blob);
        return `blob:${made.length}`;
      },
    });
    const page = pageOf('<img data-picture="1"><img data-picture="0">');
    const urls = pictured(page, [png, { ...png, media: "image/webp" }]);
    const shown = [...page.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(shown).toEqual(["blob:1", "blob:2"]);
    expect(urls).toEqual(["blob:1", "blob:2"]);
    expect(made.map((blob) => blob.type)).toEqual(["image/webp", "image/png"]);
  });

  it("that the envelope does not carry stays empty", () => {
    const page = pageOf(
      '<img data-picture="3"><img data-picture="x"><img data-picture=""><img data-picture="0x0"><img data-picture=" 0">',
    );
    expect(pictured(page, [png])).toEqual([]);
    expect(page.querySelector("img[src]")).toBeNull();
  });
});

describe("a link in the document", () => {
  it("out of it opens apart and takes nothing of the page", () => {
    const page = pageOf(
      '<a href="https://x.test">x</a><a href="mailto:a@x.test">m</a><a href="#arriba">a</a><a class="card" data-doc="d1">d</a>',
    );
    linkedOut(page);
    const said = [...page.querySelectorAll("a")].map((a) => [a.target, a.rel]);
    expect(said).toEqual([
      ["_blank", "noopener noreferrer"],
      ["_blank", "noopener noreferrer"],
      ["", ""],
      ["", ""],
    ]);
  });
});

describe("the document's title", () => {
  it("is its first line, as the page draws it", () => {
    expect(titleOf(pageOf("<h1>Docker en WSL2</h1><p>Texto</p>"))).toBe("Docker en WSL2");
    expect(titleOf(pageOf("<p>Una nota corta</p><h2>Después</h2>"))).toBe("Una nota corta");
  });

  it("comes after the front matter when the text has one", () => {
    const page = pageOf('<dl class="front"><div><dt>tags</dt></div></dl><h1>Guía</h1>');
    expect(titleOf(page)).toBe("Guía");
  });

  it("is empty when the first block is no line of words", () => {
    expect(titleOf(pageOf("<figure class='code'><pre><code>x</code></pre></figure>"))).toBe("");
  });
});

describe("a link that stays in the document", () => {
  const page = pageOf('<h2 id="antes-de-empezar">Antes</h2><p id="fn-1">Nota</p>');

  it("points at the place its # names", () => {
    expect(placeOf(page, "#antes-de-empezar")?.textContent).toBe("Antes");
    expect(placeOf(page, "#fn-1")?.textContent).toBe("Nota");
  });

  it("points nowhere when it names no place, or names it badly", () => {
    for (const href of ["#", "#nada", "#%E0%A4%A", "otro.md", "tisty:doc/d1", ""])
      expect(placeOf(page, href), href).toBeNull();
  });
});

describe("a title", () => {
  it("keeps no control or direction marks, as Tisty keeps it", () => {
    expect(plain("  Gu\u202eía\u0007 de\u2066 Docker  ")).toBe("Guía de Docker");
  });

  it("is composed and cut at 120 characters", () => {
    expect(plain("Gui\u0301a")).toBe("Guía");
    expect([...plain("é".repeat(200))]).toHaveLength(120);
  });
});

describe("a click on a link in the frame", () => {
  const clicked = (href: string, kind = "click") => {
    const page = pageOf(`<a href="${href}">ir</a><h2 id="al-final">Al final</h2>`);
    const place = page.getElementById("al-final") as HTMLElement;
    place.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    const frame = { getBoundingClientRect: () => ({ top: 60 }) } as HTMLIFrameElement;
    const scrolled = vi.fn();
    vi.stubGlobal("scrollTo", scrolled);
    linkedWithin(frame, page);
    const link = page.querySelector("a") as HTMLAnchorElement;
    const event = new MouseEvent(kind, {
      bubbles: true,
      cancelable: true,
      button: kind === "click" ? 0 : 1,
    });
    link.dispatchEvent(event);
    return { kept: event.defaultPrevented, scrolled };
  };

  it("to a place in the document stays in the frame and brings the place into view", () => {
    const { kept, scrolled } = clicked("#al-final");
    expect(kept).toBe(true);
    expect(scrolled).toHaveBeenCalledWith({ top: window.scrollY + 960 });
  });

  it("to anywhere else the document cannot reach goes nowhere", () => {
    for (const href of ["otro.md", "tisty:doc/d1", "#", "#nada"]) {
      const { kept, scrolled } = clicked(href);
      expect(kept, href).toBe(true);
      expect(scrolled, href).not.toHaveBeenCalled();
    }
  });

  it("out of the document is left to open apart", () => {
    for (const href of ["https://x.test", "mailto:a@x.test"]) {
      const { kept, scrolled } = clicked(href);
      expect(kept, href).toBe(false);
      expect(scrolled, href).not.toHaveBeenCalled();
      expect(clicked(href, "auxclick").kept, href).toBe(false);
    }
  });

  it("with the middle button opens no tab for a link the document keeps, nor walks to it", () => {
    for (const href of ["#al-final", "otro.md", "tisty:doc/d1"]) {
      const { kept, scrolled } = clicked(href, "auxclick");
      expect(kept, href).toBe(true);
      expect(scrolled, href).not.toHaveBeenCalled();
    }
  });
});

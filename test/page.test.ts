import { readFileSync } from "node:fs";
import { CONTRACTS, check, checkHtml } from "@tisty/contracts";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../src/page/sample";

const read = (path: string): string => readFileSync(path, "utf8");

interface StyleValues {
  body: { size: string; line_height: number };
  sheet: { padding: string; radius: string };
  headings: { h1: { size: string; weight: number } };
}

const WRANGLER = read("wrangler.toml");
const HEADERS = read("src/page/public/_headers");
const SHEET = read("src/page/ui/sheet.css");
const FRAME = read("src/page/ui/frame.ts");
const HTML = read("src/page/index.html");

describe("the sample", () => {
  it("is a document the contract takes, so the frame is built on what will really arrive", () => {
    expect(check("document", SAMPLE)).toEqual([]);
    expect(checkHtml(SAMPLE.html)).toEqual([]);
  });
});

describe("the page's headers", () => {
  const csp = HEADERS.match(/Content-Security-Policy: (.+)/)?.[1] ?? "";

  it("ask nothing of anyone else (decision 7), and let nothing run that is not the page's", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' blob:");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:|unsafe|\*/);
  });

  it("keep tisty.cl out of every search (decision 63)", () => {
    expect(HEADERS).toContain("X-Robots-Tag: noindex");
    expect(read("src/page/public/robots.txt")).toContain("Disallow: /");
  });
});

describe("what the page loads", () => {
  it("is all its own: no font, script or image of anyone else", () => {
    expect(HTML).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(SHEET).not.toMatch(/url\(|@import/);
    expect(read("src/page/ui/frame.css")).not.toMatch(/url\(|@import/);
  });
});

describe("the panels", () => {
  it("say the verdict once, in the bar, outside the document", () => {
    expect(HTML).toContain('id="seal-text"');
    expect(HTML).not.toContain('id="verdict"');
  });

  it("scroll with the page, with no second scrollbar of their own", () => {
    const panels = read("src/page/ui/frame.css").match(/\.panels \{[^}]*\}/g) ?? [];
    expect(panels.length).toBeGreaterThan(0);
    for (const rule of panels) expect(rule).not.toMatch(/overflow|max-height: calc/);
  });

  it("put the index right after the actions", () => {
    const at = (id: string) => HTML.indexOf(id);
    expect(at("panel-actions")).toBeLessThan(at('id="panel-index"'));
    expect(at('id="panel-index"')).toBeLessThan(at('id="panel-paper"'));
    expect(at('id="panel-paper"')).toBeLessThan(at('id="panel-details"'));
  });

  it("keep who signed it and how to check it in the details", () => {
    const details = HTML.slice(HTML.indexOf('id="panel-details"'), HTML.indexOf('class="foot"'));
    expect(details).toContain('id="signer"');
    expect(details).toContain('id="fingerprint"');
    expect(details).toContain("Cómo comprobarla");
  });

  it("say in the details only what the sheet does not already say", () => {
    expect(FRAME).not.toContain('"Título"');
    expect(FRAME).not.toContain('"Etiquetas"');
    expect(HTML.slice(HTML.indexOf('id="panel-details"'))).toContain('id="dies-on"');
  });

  it("start the index after the title, which is already the first thing on the sheet", () => {
    expect(FRAME).toContain("headings[0]?.textContent === held.title");
  });
});

describe("the assets in the Worker", () => {
  it("do not wake it: only the API runs it first, so a visit to the page costs no request", () => {
    expect(WRANGLER).toContain('run_worker_first = ["/api/*"]');
    expect(WRANGLER).toContain('not_found_handling = "single-page-application"');
    expect(WRANGLER).toContain('directory = "./dist/page"');
  });
});

describe("the contract's numbers", () => {
  const style = (CONTRACTS.style as { values: StyleValues }).values;
  const sheet = (CONTRACTS.sheet as { values: Record<string, unknown> }).values;

  it("are the ones the sheet's CSS writes", () => {
    expect(SHEET).toContain(`font-size: ${style.body.size}`);
    expect(SHEET).toContain(`line-height: ${style.body.line_height}`);
    expect(SHEET).toContain(`padding: ${style.sheet.padding}`);
    expect(SHEET).toContain(`border-radius: ${style.sheet.radius}`);
    expect(SHEET).toContain(`font-size: ${style.headings.h1.size}`);
    expect(SHEET).toContain(`font-weight: ${style.headings.h1.weight}`);
  });

  it("are the ones the paper panel works with", () => {
    const papers = sheet.millimetres as Record<string, number[]>;
    for (const [paper, [short, long]] of Object.entries(papers)) {
      expect(FRAME).toContain(`${paper}: [${short}, ${long}]`);
    }
    const margins = sheet.margin_millimetres as { x: number; y: number };
    expect(FRAME).toContain(`x: ${margins.x}, y: ${margins.y}`);
    expect(FRAME).toContain(`LONG_PAGE_WIDTH_PIXELS = ${sheet.long_page_width_pixels}`);
    expect(FRAME).toContain(`PIXELS_PER_INCH = ${sheet.pixels_per_inch}`);
  });

  it("offer the papers it says to offer", () => {
    for (const paper of sheet.offered as string[]) expect(HTML).toContain(`data-paper="${paper}"`);
  });
});

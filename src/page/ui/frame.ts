import type { Document, Orientation, Paper, Verdict } from "@tisty/contracts";
import sheetStyles from "./sheet.css?url";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
};

// From the sheet contract: what paper measures, in millimetres, and how it is worked out on screen.
const PAPER_MILLIMETRES: Record<Paper, [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  folio: [215.9, 330.2],
  tabloid: [279.4, 431.8],
};
const MARGIN_MILLIMETRES = { x: 20, y: 22 };
const PIXELS_PER_INCH = 96;
const MILLIMETRES_PER_INCH = 25.4;
const LONG_PAGE_WIDTH_PIXELS = 820;

const pixels = (millimetres: number): number => Math.round((millimetres / MILLIMETRES_PER_INCH) * PIXELS_PER_INCH);

const VERDICTS: Record<Verdict, { text: string; tone: string }> = {
  holds: { text: "Firma válida", tone: "good" },
  retired: { text: "Firma de una llave retirada después", tone: "warn" },
  doubtful: { text: "Firma dudosa: la llave estaba retirada", tone: "bad" },
  refused: { text: "La firma no vale", tone: "bad" },
  unreadable: { text: "No se pudo leer la firma", tone: "bad" },
};

export interface Seal {
  verdict: Verdict;
  fingerprint: string;
  diesOn: string;
}

const withLayout = (host: HTMLElement, sheets: boolean, paper: Paper, orientation: Orientation): void => {
  const [short, long] = PAPER_MILLIMETRES[paper];
  const across = orientation === "landscape" ? long : short;
  const down = orientation === "landscape" ? short : long;
  host.dataset.sheets = String(sheets);
  host.style.setProperty("--page-width", `${sheets ? pixels(across) : LONG_PAGE_WIDTH_PIXELS}px`);
  if (sheets) {
    host.style.setProperty("--page-height", `${pixels(down)}px`);
    host.style.setProperty("--margin-x", `${pixels(MARGIN_MILLIMETRES.x)}px`);
    host.style.setProperty("--margin-y", `${pixels(MARGIN_MILLIMETRES.y)}px`);
  }
};

const paperOf = (held: Document): Paper => {
  const said = held.sheet?.paper as Paper | undefined;
  return said && said in PAPER_MILLIMETRES ? said : "a4";
};

const pressed = (button: HTMLElement, on: boolean): void => button.setAttribute("aria-pressed", String(on));

const drawPaperPanel = (host: HTMLElement, held: Document): void => {
  const leaves = [...element("leaves").querySelectorAll<HTMLButtonElement>("button")];
  const sheets = element("sheets");
  const landscape = element("landscape");
  let paper = paperOf(held);
  let inSheets = held.sheet?.on === true;
  let across = held.sheet?.orientation === "landscape";
  const apply = (): void => {
    for (const leaf of leaves) {
      pressed(leaf, leaf.dataset.paper === paper);
      // Tabloid is not offered, but a document that asked for it keeps it.
      if (leaf.dataset.paper === paper) leaf.hidden = false;
    }
    pressed(sheets, inSheets);
    pressed(landscape, across);
    landscape.hidden = !inSheets;
    withLayout(host, inSheets, paper, across ? "landscape" : "portrait");
  };
  for (const leaf of leaves) {
    leaf.addEventListener("click", () => {
      paper = leaf.dataset.paper as Paper;
      apply();
    });
  }
  sheets.addEventListener("click", () => {
    inSheets = !inSheets;
    apply();
  });
  landscape.addEventListener("click", () => {
    across = !across;
    apply();
  });
  apply();
};

const drawIndex = (root: ShadowRoot, held: Document): void => {
  const list = element("index");
  const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
  // The title is already the first thing on the sheet, so the index starts after it.
  const shown = headings[0]?.textContent === held.title ? headings.slice(1) : headings;
  for (const heading of shown) {
    const item = document.createElement("li");
    item.dataset.level = heading.tagName.slice(1);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = heading.textContent;
    // Inside the document only, so an id in it can never lead to the page around it.
    button.addEventListener("click", () => {
      closePanel();
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    item.append(button);
    list.append(item);
  }
  element("panel-index").hidden = list.childElementCount === 0;
};

const fact = (list: HTMLElement, name: string, value: string): void => {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = name;
  const said = document.createElement("dd");
  said.textContent = value;
  row.append(term, said);
  list.append(row);
};

const dayOf = (moment: string): string => new Date(moment).toLocaleDateString(undefined, { dateStyle: "medium" });

// What the sheet does not already say: the title and tags are on it, and the paper is in its own panel.
const SAID_ELSEWHERE = new Set(["title", "tags", "tag", "paper", "sheets", "orientation", "lang"]);

const drawDetails = (root: ShadowRoot, held: Document): void => {
  const list = element("details");
  if (held.made) fact(list, "Creado", dayOf(held.made));
  if (held.wrote) fact(list, "Editado", dayOf(held.wrote));
  // The properties travel hidden in the HTML, and a reader shows them here (contract, «text»).
  for (const name of root.querySelectorAll("dl.front > dt")) {
    const key = name.textContent ?? "";
    const value = name.nextElementSibling;
    if (!SAID_ELSEWHERE.has(key.toLowerCase()) && value?.tagName === "DD") fact(list, key, value.textContent ?? "");
  }
  list.hidden = list.childElementCount === 0;
};

const drawSeal = (held: Document, { verdict, fingerprint, diesOn }: Seal): void => {
  const { text, tone } = VERDICTS[verdict];
  const seal = element("seal");
  seal.hidden = false;
  seal.dataset.tone = tone;
  element("seal-text").textContent = text;
  element("signer").textContent = held.signed_as ?? "Sin nombre";
  element("fingerprint").textContent = fingerprint;
  element("dies-on").textContent = diesOn;
};

const drawActions = (): void => {
  element<HTMLAnchorElement>("open-in-tisty").href = `tisty://folio?link=${encodeURIComponent(location.href)}`;
  const label = element("copy-link-text");
  const said = label.textContent;
  element("copy-link").addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    label.textContent = "Copiado";
    setTimeout(() => {
      label.textContent = said;
    }, 1500);
  });
};

let opener: HTMLElement | null = null;

const closePanel = (): void => {
  for (const panel of document.querySelectorAll<HTMLElement>(".panel[data-open]")) delete panel.dataset.open;
  element("scrim").hidden = true;
  opener?.focus();
  opener = null;
};

const drawDock = (): void => {
  const dock = element("dock");
  dock.hidden = false;
  dock.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button[data-panel]");
    if (!button?.dataset.panel) return;
    const panel = element(button.dataset.panel);
    const wasOpen = panel.dataset.open !== undefined;
    closePanel();
    if (wasOpen) return;
    panel.dataset.open = "";
    panel.tabIndex = -1;
    panel.focus();
    opener = button;
    element("scrim").hidden = false;
  });
  element("scrim").addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
};

// The sheet goes in a shadow root, which keeps its CSS, ids and classes apart in both directions.
const drawSheet = (host: HTMLElement, held: Document, words: DocumentFragment): ShadowRoot => {
  const root = host.attachShadow({ mode: "closed" });
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = sheetStyles;
  const sheet = document.createElement("article");
  sheet.className = "sheet";
  if (held.lang) sheet.lang = held.lang;
  if (held.tags?.length) {
    const tags = document.createElement("p");
    tags.className = "tags";
    for (const tag of held.tags) {
      const one = document.createElement("span");
      one.textContent = `#${tag}`;
      tags.append(one);
    }
    sheet.append(tags);
  }
  sheet.append(words);
  root.append(styles, sheet);
  return root;
};

// What it draws is already clean: `words` is what the cleaner gave back, never the HTML as it arrived.
export const drawFrame = (held: Document, words: DocumentFragment, seal: Seal): void => {
  const host = element("sheet");
  const root = drawSheet(host, held, words);
  document.title = held.title ? `${held.title} · Folio` : "Folio by Tisty";
  drawPaperPanel(host, held);
  drawIndex(root, held);
  drawDetails(root, held);
  drawSeal(held, seal);
  drawActions();
  drawDock();
  element("loading").hidden = true;
  element("desk").hidden = false;
  document.body.dataset.state = "open";
};

export const drawClosed = (said: string): void => {
  element("loading-text").textContent = said;
  document.body.dataset.state = "closed";
};

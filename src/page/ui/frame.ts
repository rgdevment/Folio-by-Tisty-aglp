import type { Document, Orientation, Page, Paper, Verdict } from "@tisty/contracts";
import { bareUrl } from "./clean";
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

const drawIndex = (root: ShadowRoot, held: Document | Page): void => {
  const list = element("index");
  list.replaceChildren();
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
  const empty = list.childElementCount === 0 && element("pages").childElementCount === 0;
  element("panel-index").hidden = empty;
  // On a phone its button would open a dimmed screen with nothing on it.
  for (const button of element("dock").querySelectorAll<HTMLElement>('[data-panel="panel-index"]')) {
    button.hidden = empty;
  }
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

const tagsOf = (tags: string[]): HTMLElement => {
  const list = document.createElement("p");
  list.className = "tags";
  for (const tag of tags) {
    const one = document.createElement("span");
    one.textContent = `#${tag}`;
    list.append(one);
  }
  return list;
};

const REFERENCE = /^tisty:(page|cited)\/(\d+)$/i;

// Nothing here changes the address by itself: the part after its # holds the link key (contract, «links»).
const followLink = (event: Event, root: ShadowRoot, held: Document, goTo: (page: Page) => void): void => {
  const link = (event.target as Element).closest("a");
  const where = bareUrl(link?.getAttribute("href") ?? "");
  if (!where || link?.getAttribute("target") === "_blank") return;
  event.preventDefault();
  if (where.startsWith("#")) {
    root.getElementById(where.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const [, kind, at] = REFERENCE.exec(where) ?? [];
  if (kind?.toLowerCase() === "page") {
    const page = held.pages?.find((one) => one.at === Number(at));
    if (page) goTo(page);
  } else if (kind?.toLowerCase() === "cited") {
    const cited = held.cited?.[Number(at)];
    if (cited) location.assign(`/${encodeURIComponent(cited.document)}#${encodeURIComponent(cited.key ?? "")}`);
  }
};

const drawPages = (held: Document, goTo: (shown: Document | Page) => void): void => {
  const list = element("pages");
  const pages = held.pages ?? [];
  if (pages.length === 0) return;
  for (const shown of [held, ...pages]) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = shown.title ?? "Sin título";
    button.addEventListener("click", () => {
      closePanel();
      goTo(shown);
    });
    item.append(button);
    list.append(item);
  }
};

const markPage = (at: number): void => {
  for (const [place, button] of element("pages").querySelectorAll("button").entries()) {
    if (place === at) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
};

// What it draws is already clean: `wordsOf` gives what the cleaner gave back, never the HTML as it arrived.
export const drawFrame = (held: Document, wordsOf: (html: string) => DocumentFragment, seal: Seal): void => {
  const host = element("sheet");
  // The sheet goes in a shadow root, which keeps its CSS, ids and classes apart in both directions.
  const root = host.attachShadow({ mode: "closed" });
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = sheetStyles;
  const sheet = document.createElement("article");
  sheet.className = "sheet";
  root.append(styles, sheet);

  const goTo = (shown: Document | Page): void => {
    sheet.lang = shown.lang ?? held.lang ?? "";
    sheet.replaceChildren(...(shown.tags?.length ? [tagsOf(shown.tags)] : []), wordsOf(shown.html));
    document.title = shown.title ? `${shown.title} · Folio` : "Folio by Tisty";
    markPage(shown === held ? 0 : (held.pages ?? []).indexOf(shown as Page) + 1);
    drawIndex(root, shown);
    scrollTo({ top: 0 });
  };
  root.addEventListener("click", (event) => followLink(event, root, held, goTo));

  drawPages(held, goTo);
  goTo(held);
  drawPaperPanel(host, held);
  drawDetails(root, held);
  drawSeal(held, seal);
  drawActions();
  drawDock();
  element("loading").hidden = true;
  element("desk").hidden = false;
  document.body.dataset.state = "open";
};

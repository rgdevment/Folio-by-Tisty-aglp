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

const drawPaperPanel = (host: HTMLElement, held: Document): void => {
  const paper = element<HTMLSelectElement>("paper");
  const sheets = element<HTMLInputElement>("sheets");
  const orientation = element<HTMLSelectElement>("orientation");
  const apply = (): void => {
    orientation.disabled = !sheets.checked;
    withLayout(host, sheets.checked, paper.value as Paper, orientation.value as Orientation);
  };
  paper.value = paperOf(held);
  sheets.checked = held.sheet?.on === true;
  orientation.value = held.sheet?.orientation === "landscape" ? "landscape" : "portrait";
  for (const control of [paper, sheets, orientation]) control.addEventListener("change", apply);
  apply();
};

const drawIndex = (root: ShadowRoot): void => {
  const list = element("index");
  for (const heading of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
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

const drawDetails = (held: Document): void => {
  const list = element("details");
  if (held.title) fact(list, "Título", held.title);
  if (held.tags?.length) fact(list, "Etiquetas", held.tags.map((one) => `#${one}`).join(" "));
  if (held.made) fact(list, "Creado", dayOf(held.made));
  if (held.wrote) fact(list, "Editado", dayOf(held.wrote));
};

const drawSeal = (held: Document, { verdict, fingerprint, diesOn }: Seal): void => {
  const { text, tone } = VERDICTS[verdict];
  const seal = element("seal");
  seal.hidden = false;
  seal.dataset.tone = tone;
  element("seal-text").textContent = text;
  const shown = element("verdict");
  shown.dataset.tone = tone;
  shown.textContent = text;
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
  drawIndex(root);
  drawDetails(held);
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

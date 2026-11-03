import {
  acrossOf,
  ending,
  fileCard,
  kept,
  PAPERS,
  type Paper,
  readAs,
  type Say,
  type Sheet,
  sheetFor,
  sheeting,
  shell,
  TITLED,
} from "tisty-editor/read";
import { type Cited, cardOf, citing } from "./cited";
import { cleaned } from "./clean";
import type { About } from "./frame";

export type Picture = { readonly bytes: Uint8Array<ArrayBuffer>; readonly media: string };
export type Opened = {
  readonly html: string;
  readonly pictures: readonly Picture[];
  readonly cited: readonly Cited[];
  /** The language the writer's Tisty says the words are in, so a screen reader and hyphens follow it. */
  readonly lang?: string | null;
};

// The text names each picture by its place in the envelope, as Tisty seals it.
export const PICTURE = "tisty:picture/";

const OUTSIDE = /^(https?:|mailto:)/i;

// Control and direction marks, which Tisty keeps out of a title so none can dress one up as another.
const MARKS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

// An attachment of Tisty's that is no picture stays there; its kind is kept before cleaning drops where it lay.
export const filed = (html: string): string =>
  html.replace(/<img src="([^"]*)"/g, (all, at: string) => {
    const kind = ending(at);
    return kept(at) && /^[a-z0-9]{1,8}$/.test(kind) ? `<img data-file="${kind}"` : all;
  });

// Drawn as Tisty draws a file, saying it did not travel.
export const fileCards = (page: Document, stays: string) => {
  for (const img of page.querySelectorAll<HTMLImageElement>("img[data-file]")) {
    const kind = img.dataset.file ?? "";
    const { card } = fileCard(
      page,
      img,
      kind,
      img.alt || kind.toUpperCase(),
      `${kind.toUpperCase()} · ${stays}`,
    );
    card.title = stays;
  }
};

// Set aside before the frame reads the html, so the browser never asks for a picture by its name.
export const unasked = (html: string): string =>
  html.replaceAll(`<img src="${PICTURE}`, '<img data-picture="');

// Each picture the text names becomes a blob of its own bytes: nothing is asked of anyone to show it.
export const pictured = (page: Document, pictures: readonly Picture[]): string[] => {
  const made: string[] = [];
  for (const img of page.querySelectorAll<HTMLImageElement>("img[data-picture]")) {
    const at = img.dataset.picture ?? "";
    const picture = /^\d+$/.test(at) ? pictures[Number(at)] : undefined;
    if (!picture) continue;
    const url = URL.createObjectURL(new Blob([picture.bytes], { type: picture.media }));
    made.push(url);
    const shaped = () => {
      img.removeAttribute("width");
      img.removeAttribute("height");
    };
    img.addEventListener("load", shaped, { once: true });
    img.src = url;
  }
  return made;
};

// A link out of the document opens apart, and takes nothing of this page with it.
export const linkedOut = (page: Document) => {
  for (const link of page.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!OUTSIDE.test(link.getAttribute("href") ?? "")) continue;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
};

export const placeOf = (page: Document, href: string): Element | null => {
  if (!href.startsWith("#") || href.length < 2) return null;
  try {
    return page.getElementById(decodeURIComponent(href.slice(1)));
  } catch {
    return null;
  }
};

// The frame's links resolve against this page's address, so one that stays in the document is walked by hand.
export const linkedWithin = (frame: HTMLIFrameElement, page: Document) => {
  const within = (event: Event): string | null => {
    const href = (event.target as Element | null)?.closest?.("a[href]")?.getAttribute("href");
    return href == null || OUTSIDE.test(href) ? null : href;
  };
  // Nor does a middle click open one in a tab of its own, which would take its # for the link's key.
  page.addEventListener("auxclick", (event) => {
    if (within(event) !== null) event.preventDefault();
  });
  page.addEventListener("click", (event) => {
    const href = within(event);
    if (href === null) return;
    event.preventDefault();
    const place = placeOf(page, href);
    if (!place) return;
    const top = frame.getBoundingClientRect().top + place.getBoundingClientRect().top;
    window.scrollTo({ top: window.scrollY + top });
  });
};

// As Tisty keeps a title: without marks, composed, trimmed and at most 120 characters.
export const plain = (said: string): string =>
  [...said.replace(MARKS, "").normalize("NFC").trim()].slice(0, 120).join("");

export const titleOf = (page: Document): string =>
  plain(page.querySelector(TITLED)?.textContent ?? "");

const grows = (frame: HTMLIFrameElement, page: Document) => {
  const sheet = page.querySelector<HTMLElement>(".page");
  const Seeing = page.defaultView?.ResizeObserver;
  if (!sheet || !Seeing) return;
  const sized = () => {
    frame.style.height = `${Math.ceil(sheet.getBoundingClientRect().height)}px`;
  };
  sized();
  new Seeing(sized).observe(sheet);
};

const loaded = (frame: HTMLIFrameElement, html: string) =>
  new Promise<Document>((done) => {
    frame.addEventListener("load", () => done(frame.contentDocument as Document), { once: true });
    frame.srcdoc = html;
  });

export type View = { readonly leaf: Paper; readonly sheets: boolean; readonly landscape: boolean };

// The paper the document asks for, A4 unless it says otherwise or asks for one this page lacks; the reader may look at it on another.
export const viewOf = (about: About): View => {
  const sheets = about.sheets === true;
  return {
    leaf: PAPERS.find((one) => one === about.paper) ?? "a4",
    sheets,
    landscape: sheets && about.landscape === true,
  };
};

export type Laid = { readonly across: number; readonly sheet?: Sheet };

// Lying across only means something while the sheets are laid.
export const laidOut = ({ leaf, sheets, landscape }: View, say: Say): Laid => {
  const across = sheets && landscape;
  return {
    across: acrossOf(leaf, across),
    sheet: sheets ? sheetFor(leaf, across, say("sheetsBreak")) : undefined,
  };
};

// On a screen narrower than the paper, as a phone's, the sheets would break where no sheet ends, so the body flows as one.
export const fitting = (frame: HTMLIFrameElement, laid: () => Laid) => () => {
  const { sheet } = laid();
  return sheet && frame.clientWidth >= sheet.wide ? sheet : undefined;
};

export type Drawn = {
  readonly page: Document;
  readonly lay: () => void;
  readonly picture: (pictures: readonly Picture[]) => void;
};

// The body as Tisty draws it, in the reader's own frame, grown to its height so the page scrolls as one.
export const drawn = async (
  frame: HTMLIFrameElement,
  opened: Opened,
  dark: boolean,
  said: { readonly say: Say; readonly language: string; readonly stays: string },
  laid: () => Laid,
  onCited: (one: Cited) => void,
): Promise<Drawn> => {
  const page = await loaded(frame, shell(unasked(cleaned(filed(opened.html))), dark));
  page.documentElement.classList.add("tall");
  if (opened.lang) page.documentElement.lang = opened.lang;
  page.querySelector(".page")?.removeAttribute("inert");
  const live = () => frame.contentDocument === page;
  let made: string[] = [];
  const read = readAs(page, {
    say: said.say,
    locale: said.language,
    live,
    brought: () => {
      made = pictured(page, opened.pictures);
      fileCards(page, said.stays);
    },
    sites: {},
    cards: { card: cardOf(opened.cited) },
  });
  // Another paper only lays the same body again: nothing is drawn twice and the reader keeps their place.
  let sheets = { stop: () => {} };
  const lay = () => {
    page.documentElement.style.setProperty("--wide", `${laid().across}px`);
    sheets.stop();
    sheets = sheeting(page, fitting(frame, laid));
  };
  lay();
  const freed = () => {
    for (const url of made) URL.revokeObjectURL(url);
    for (const stop of read.kept) stop();
    sheets.stop();
  };
  frame.addEventListener("load", freed, { once: true });
  linkedOut(page);
  linkedWithin(frame, page);
  citing(page, opened.cited, onCited);
  grows(frame, page);
  await read.drawn;
  const picture = (pictures: readonly Picture[]) => {
    made = [...made, ...pictured(page, pictures)];
  };
  return { page, lay, picture };
};

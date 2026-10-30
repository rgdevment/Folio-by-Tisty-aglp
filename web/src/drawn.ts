import {
  acrossOf,
  laidIn,
  type Paper,
  readAs,
  type Say,
  type Sheet,
  sheetFor,
  sheeting,
  shell,
  TITLED,
} from "tisty-editor/read";

export type Picture = { readonly bytes: Uint8Array<ArrayBuffer>; readonly media: string };
export type Opened = { readonly html: string; readonly pictures: readonly Picture[] };

// The text names each picture by its place in the envelope, as Tisty seals it.
export const PICTURE = "tisty:picture/";

const OUTSIDE = /^(https?:|mailto:)/i;

// Control and direction marks, which Tisty keeps out of a title so none can dress one up as another.
const MARKS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

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

// The paper the document asks for, A4 unless it says otherwise; the reader may look at it on another.
export const viewOf = (text: string): View => {
  const laid = laidIn(text);
  return { leaf: laid.paper ?? "a4", sheets: laid.sheets, landscape: laid.landscape };
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

export type Drawn = { readonly page: Document; readonly lay: () => void };

// The body as Tisty draws it, in the reader's own frame, grown to its height so the page scrolls as one.
export const drawn = async (
  frame: HTMLIFrameElement,
  opened: Opened,
  dark: boolean,
  said: { readonly say: Say; readonly language: string },
  laid: () => Laid,
): Promise<Drawn> => {
  const page = await loaded(frame, shell(unasked(opened.html), dark));
  page.documentElement.classList.add("tall");
  page.querySelector(".page")?.removeAttribute("inert");
  const live = () => frame.contentDocument === page;
  let made: string[] = [];
  const read = readAs(page, {
    say: said.say,
    locale: said.language,
    live,
    brought: () => {
      made = pictured(page, opened.pictures);
    },
    sites: {},
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
  grows(frame, page);
  await read.drawn;
  return { page, lay };
};

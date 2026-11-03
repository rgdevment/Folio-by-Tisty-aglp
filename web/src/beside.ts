import { type Act, copyFrom, type Head, type Panel, type Say, weighed } from "tisty-editor/read";
import type { View } from "./drawn";
import type { Facts } from "./fetched";
import { type About, sealOf, tistyOf } from "./frame";
import { stamped } from "./when";

export type Now = {
  readonly title: string;
  readonly text?: string;
  readonly about: About;
  readonly facts: Facts;
  readonly view: View;
  readonly raw: boolean;
  readonly heads: readonly Head[];
};

export type Asked = {
  readonly onView: (view: View) => void;
  readonly onRaw: (raw: boolean) => void;
  /** Only a phone shows it: there the panels cover the sheet until put away. */
  readonly onShut: () => void;
};

export type Words = {
  readonly sheet: Say;
  readonly page: (word: string) => string;
  readonly language: string;
};

/** The address as it was opened, which Tisty takes whole, and the link to read, which is what is passed on. */
export type Links = { readonly opened: string; readonly read: string };

const copying = (what: string, said: string, done: string) => (at: HTMLElement) =>
  copyFrom(at, what, said, done);

/** Where Tisty is downloaded, which the page's own header links to as well. */
export const GET_TISTY = "/";

// A link to an app nobody installed opens nothing, so with the page still in front a moment later it offers the app instead.
export const falling =
  (hint: string, wait = 1500) =>
  (at: HTMLElement) => {
    setTimeout(() => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (!(at instanceof HTMLAnchorElement)) return;
      at.href = GET_TISTY;
      at.textContent = hint;
    }, wait);
  };

// What the window's details say of a document, from what the link holds: who signed it, when it was shared and last edited, and its size.
const detailsOf = (now: Now, language: string) => {
  const writer = now.about.wrote && "fingerprint" in now.about.wrote ? now.about.wrote : undefined;
  return {
    body: now.text,
    fields: now.about.fields ?? [],
    author: writer?.name,
    made: now.facts.shared === undefined ? undefined : stamped(now.facts.shared, language),
    wrote: now.facts.written === undefined ? undefined : stamped(now.facts.written, language),
    weighs: now.text === undefined ? undefined : weighed(new TextEncoder().encode(now.text).length),
  };
};

// The panels a reader of a shared document needs, from the same catalogue the window draws from.
export const panelsOf = (now: Now, asked: Asked, words: Words, links: Links): Panel[] => {
  const { view, text } = now;
  const turned = (next: Partial<View>) => asked.onView({ ...view, ...next });
  const markdown: Act[] =
    text === undefined
      ? []
      : [
          {
            key: "md",
            label: words.page("copymd"),
            onPick: copying(text, words.page("copymd"), words.page("copiedmd")),
          },
        ];
  return [
    {
      kind: "title",
      title: now.title || words.page("document"),
      onShut: asked.onShut,
    },
    {
      kind: "paper",
      leaf: view.leaf,
      onLeaf: (leaf) => turned({ leaf }),
      sheets: { on: view.sheets, onTurn: (sheets) => turned({ sheets }) },
      landscape: view.sheets
        ? { on: view.landscape, onTurn: (landscape) => turned({ landscape }) }
        : undefined,
      raw: text === undefined ? undefined : { on: now.raw, onTurn: asked.onRaw },
    },
    { kind: "index", heads: now.heads },
    { kind: "details", facts: detailsOf(now, words.language) },
    { kind: "seal", seal: sealOf(now.about, words.language) },
    {
      kind: "acts",
      acts: [
        {
          key: "open",
          label: words.page("openin"),
          main: true,
          href: tistyOf(links.opened),
          onPick: falling(words.page("notopened")),
        },
        ...markdown,
        {
          key: "copy",
          label: words.page("copy"),
          onPick: copying(links.read, words.page("copy"), words.page("copied")),
        },
      ],
    },
  ];
};

// The sheet's signature row has no line for it, so it is added once the row is drawn, open unless the reader shut it.
export const signedApart = (host: HTMLElement, said: string) => {
  const row = host.querySelector<HTMLDetailsElement>('details[data-row="seal"]');
  const body = row?.querySelector(".side-row-body");
  if (!row || !body) return;
  const line = host.ownerDocument.createElement("p");
  line.className = "side-said";
  line.textContent = said;
  body.append(line);
  if (row.dataset.chosen === undefined) row.open = true;
};

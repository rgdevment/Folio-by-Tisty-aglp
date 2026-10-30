import { fields, type Head, type Panel, type Say } from "tisty-editor/read";
import type { View } from "./drawn";
import { type About, fileOf, sealOf, tistyOf } from "./frame";

export type Now = {
  readonly title: string;
  readonly text: string;
  readonly about: About;
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

export type Words = { readonly sheet: Say; readonly page: (word: string) => string };

const COPIED_MS = 2000;

const copying = (link: string, page: Words["page"]) => (at: HTMLElement) => {
  navigator.clipboard.writeText(link).then(
    () => {
      at.textContent = page("copied");
      setTimeout(() => {
        at.textContent = page("copy");
      }, COPIED_MS);
    },
    () => undefined,
  );
};

// The file is made when it is asked for, so the page never holds the words twice until then.
const downloading = (text: string) => (at: HTMLElement) => {
  const link = at as HTMLAnchorElement;
  if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
};

// The panels a reader of a shared document needs, from the same catalogue the window draws from.
export const panelsOf = (now: Now, asked: Asked, words: Words, link: string): Panel[] => {
  const { view } = now;
  const turned = (next: Partial<View>) => asked.onView({ ...view, ...next });
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
      raw: { on: now.raw, onTurn: asked.onRaw },
    },
    { kind: "index", heads: now.heads },
    { kind: "details", facts: { body: now.text, fields: fields(now.text) } },
    { kind: "seal", seal: sealOf(now.about) },
    {
      kind: "acts",
      acts: [
        { key: "open", label: words.page("openin"), main: true, href: tistyOf(link) },
        {
          key: "md",
          label: words.page("download"),
          href: "#",
          download: fileOf(now.title, words.page("document")),
          onPick: downloading(now.text),
        },
        { key: "copy", label: words.page("copy"), onPick: copying(link, words.page) },
      ],
    },
  ];
};

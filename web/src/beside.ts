import { copyFrom, fields, type Head, type Panel, type Say } from "tisty-editor/read";
import type { View } from "./drawn";
import { type About, sealOf, tistyOf } from "./frame";

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

export type Words = {
  readonly sheet: Say;
  readonly page: (word: string) => string;
  readonly language: string;
};

/** The address as it was opened, which Tisty takes whole, and the link to read, which is what is passed on. */
export type Links = { readonly opened: string; readonly read: string };

const copying = (what: string, said: string, done: string) => (at: HTMLElement) =>
  copyFrom(at, what, said, done);

// The panels a reader of a shared document needs, from the same catalogue the window draws from.
export const panelsOf = (now: Now, asked: Asked, words: Words, links: Links): Panel[] => {
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
    { kind: "seal", seal: sealOf(now.about, words.language) },
    {
      kind: "acts",
      acts: [
        { key: "open", label: words.page("openin"), main: true, href: tistyOf(links.opened) },
        {
          key: "md",
          label: words.page("copymd"),
          onPick: copying(now.text, words.page("copymd"), words.page("copiedmd")),
        },
        {
          key: "copy",
          label: words.page("copy"),
          onPick: copying(links.read, words.page("copy"), words.page("copied")),
        },
      ],
    },
  ];
};

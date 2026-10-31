import { type Seal, TITLED } from "tisty-editor/read";
import type { Facts } from "./fetched";
import { ago, day } from "./when";
import { filled } from "./words";

export type Signed =
  | {
      readonly is: "holds" | "revoked";
      readonly fingerprint: string;
      /** The name and the moment the writer signed with, which their key vouches for; an uploader's has neither. */
      readonly name?: string;
      readonly signed?: number;
    }
  | { readonly is: "refused" | "unreadable" };

export type About = {
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly version?: number;
  readonly wrote?: Signed | null;
  readonly sent?: Signed | null;
};

type Say = (word: string) => string;

// A first version was written when it was shared, so only a later one says it was edited.
export const whenOf = (
  facts: Facts,
  version: number,
  now: number,
  language: string,
  say: Say,
): string =>
  [
    facts.shared === undefined ? "" : filled(say("shared"), day(facts.shared, language)),
    facts.written === undefined || version < 2
      ? ""
      : filled(say("written"), ago(facts.written, now, language)),
  ]
    .filter(Boolean)
    .join(" · ");

// Who wrote it is what the reader asks; who uploaded it is said too, but only when it was someone else.
// The uploader never stands in for the writer: a body with no signature of its own is nobody's.
export const sealOf = (about: About, language: string): Seal => {
  const signed = about.wrote;
  if (!signed) return { verdict: "unsigned" };
  const writer = "fingerprint" in signed ? signed : undefined;
  const sent = about.sent && "fingerprint" in about.sent ? about.sent : undefined;
  return {
    verdict: signed.is,
    name: writer?.name,
    signedOn: writer?.signed === undefined ? undefined : day(writer.signed, language),
    fingerprint: writer?.fingerprint,
    sender: sent && sent.fingerprint !== writer?.fingerprint ? sent.fingerprint : undefined,
  };
};

const chips = (made: Document, tags: readonly string[]) =>
  tags.map((tag) => {
    const one = made.createElement("span");
    one.className = "tag";
    one.textContent = `#${tag}`;
    return one;
  });

// The body leaves its front matter undrawn, so its tags are shown by the frame.
export const tagged = (row: HTMLElement, tags: readonly string[]) => {
  row.replaceChildren(...chips(row.ownerDocument, tags));
  row.hidden = tags.length === 0;
};

// The byline takes over the line that closes the title, so the header reads as one: title, then tags and dates.
// Important, since the reader styles a title after front matter with a selector no plainer rule outweighs.
const BYLINE = [
  ".page > :has(+ .byline) { margin-bottom: 10px !important; padding-bottom: 0 !important; border-bottom: 0 !important }",
  ".byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 22px; padding-bottom: 16px; border-bottom: 1px solid var(--tisty-hair); font-size: 14px; color: var(--tisty-soft) }",
  ".byline .tag { color: var(--tisty-ink); background: var(--tisty-mark-doc); border-radius: 6px; padding: 2px 8px; font-size: 13px }",
].join("\n");

// Placed right after the body's own title, so no line of the body moves; a body with no title gets none.
export const bylined = (page: Document, tags: readonly string[], when: string): boolean => {
  const title = page.querySelector(TITLED);
  if (!title || (tags.length === 0 && !when)) return false;
  const style = page.createElement("style");
  style.textContent = BYLINE;
  page.head.append(style);
  const line = page.createElement("div");
  line.className = "byline";
  line.append(...chips(page, tags));
  if (when) line.append(Object.assign(page.createElement("span"), { textContent: when }));
  title.after(line);
  return true;
};

export const accessOf = (facts: Facts): string => (facts.gated ? "gated" : "unlisted");

// Every reading pushes the end back (decision 50), which the note under the date says.
export const endsOf = (facts: Facts, language: string): string =>
  facts.ends === undefined ? "" : day(facts.ends, language, "medium");

// Tisty takes the whole link, key and all, from its own scheme; the browser hands it over only on a click.
export const tistyOf = (link: string): string => `tisty://share?link=${encodeURIComponent(link)}`;

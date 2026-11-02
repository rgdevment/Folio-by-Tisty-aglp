import type { Carded } from "tisty-editor/read";
import { fetched } from "./fetched";
import { gated } from "./words";

/** A document the shared one cites, in an envelope of its own opened by its own key; `page` counts from 1. */
export type Cited = {
  readonly doc: string;
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly page?: readonly [number, number];
};

const said = (one: unknown): one is string => typeof one === "string";

const paged = (page: unknown): page is readonly [number, number] =>
  Array.isArray(page) && page.length === 2 && page.every(Number.isInteger);

const citedOne = (one: unknown): Cited | null => {
  if (typeof one !== "object" || one === null) return null;
  const { doc, id, key, title, page } = one as Record<string, unknown>;
  if (!said(doc) || !said(id) || !said(key) || !said(title)) return null;
  if (page !== undefined && !paged(page)) return null;
  return page === undefined ? { doc, id, key, title } : { doc, id, key, title, page };
};

// The list was sealed and signed with the body, so one that does not read is only left out, never trusted in part.
export const citedOf = (list: string): Cited[] => {
  try {
    const all: unknown = JSON.parse(list);
    return Array.isArray(all) ? all.map(citedOne).filter((one) => one !== null) : [];
  } catch {
    return [];
  }
};

// A card naming a document this one did not carry reads as not shared with it.
export const cardOf =
  (cited: readonly Cited[]) =>
  (file: string): Carded => {
    const one = cited.find((each) => each.doc === file);
    if (!one) return { kind: "gone" };
    if (!one.page) return { kind: "doc", title: one.title };
    const [at, of] = one.page;
    return { kind: "page", title: one.title, at, of };
  };

export const citedAt = (target: EventTarget | null, cited: readonly Cited[]): Cited | undefined => {
  const file = (target as Element | null)?.closest?.<HTMLElement>(
    ".doc-card[data-doc], a.card[data-doc]",
  )?.dataset.doc;
  return file === undefined ? undefined : cited.find((one) => one.doc === file);
};

// The sheet draws the cards and leaves where they go to the page, which opens them in its own place.
export const citing = (page: Document, cited: readonly Cited[], onCited: (one: Cited) => void) =>
  page.addEventListener("click", (event) => {
    const one = citedAt(event.target, cited);
    if (!one) return;
    event.preventDefault();
    onCited(one);
  });

const LOST = new Set(["missing", "gone"]);

// A cited document never leaves the page nor asks a password: what keeps it from the reader is said in place.
export const citedWord = (word: string): string => {
  if (LOST.has(word)) return "citedGone";
  return gated(word) ? "failed" : word;
};

// Each cited document is fetched once for the page's life; one that failed is asked again next time.
export const keeping = <T>(open: (one: Cited) => Promise<T | string>) => {
  const kept = new Map<string, Promise<T | string>>();
  return (one: Cited): Promise<T | string> => {
    const known = kept.get(one.id);
    if (known) return known;
    const opening = open(one).then((found) => {
      if (typeof found === "string") kept.delete(one.id);
      return found;
    });
    kept.set(one.id, opening);
    return opening;
  };
};

type Answer = Exclude<Awaited<ReturnType<typeof fetched>>, { refused: string }>;

// Asked as the shared document is, with no password: a cited one carries none of its own.
export const citedOpening = <T>(
  read: (one: Cited, answer: Answer) => Promise<T | string>,
  ask: typeof fetch = fetch,
) =>
  keeping(async (one: Cited): Promise<T | string> => {
    const answer = await fetched(one.id, ask);
    const found = "refused" in answer ? answer.refused : await read(one, answer);
    return typeof found === "string" ? citedWord(found) : found;
  });

type Steps = Pick<History, "pushState" | "back" | "go">;

const atOf = (state: unknown): number => {
  const at = (state as { at?: unknown } | null)?.at;
  return typeof at === "number" && Number.isInteger(at) && at > 0 ? at : 0;
};

// Only the step's place goes into the history: the keys stay in memory, the address stays the link.
export const walking = <T>(root: T, steps: Steps, show: (one: T, at: number) => void) => {
  const trail: T[] = [root];
  let at = 0;
  return {
    at: () => at,
    deep: () => at > 0,
    went: (next: T) => {
      trail.length = at + 1;
      trail.push(next);
      at += 1;
      steps.pushState({ at }, "");
      show(next, at);
    },
    back: () => steps.back(),
    // A step from before a reload is gone from memory, so the reader goes straight to the shared document's own entry.
    popped: (state: unknown) => {
      const asked = atOf(state);
      if (asked > trail.length - 1) {
        steps.go(-asked);
        return;
      }
      at = asked;
      show(trail[at], at);
    },
  };
};

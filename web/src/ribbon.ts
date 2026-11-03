import type { Cited } from "./cited";

/** Where a document opened from another sits: one of its pages in order, or a document it cites. */
export type Placed = {
  readonly up: string;
  readonly at?: readonly [number, number];
  readonly back?: Cited;
  readonly on?: Cited;
};

export type Ribboned = {
  readonly whereThisSits: string;
  readonly leafBack: string;
  readonly leafOn: string;
  readonly leafNext: string;
  readonly leafOfMany: (at: number, of: number) => string;
};

// A page knows its sisters from the list of the document it was opened from, in the order its pages run.
export const placedIn = (one: Cited, up: string, from: readonly Cited[]): Placed => {
  if (!one.page) return { up };
  const pages = from
    .filter((each) => each.page)
    .sort((a, b) => (a.page?.[0] ?? 0) - (b.page?.[0] ?? 0));
  const at = pages.findIndex((each) => each.id === one.id);
  return {
    up,
    at: one.page,
    back: at > 0 ? pages[at - 1] : undefined,
    on: at >= 0 ? pages[at + 1] : undefined,
  };
};

const button = (className: string, said: string, run?: () => void) => {
  const one = document.createElement("button");
  one.type = "button";
  one.className = className;
  one.textContent = said;
  if (run) one.addEventListener("click", run);
  else one.disabled = true;
  return one;
};

// The bar over the sheet, as Tisty draws it: back to the document above, and a page's place among its sisters.
export const ribbon = (
  bar: HTMLElement,
  placed: Placed | null,
  words: Ribboned,
  go: { readonly up: () => void; readonly to: (one: Cited) => void },
) => {
  bar.hidden = placed === null;
  bar.replaceChildren();
  if (!placed) return;
  bar.setAttribute("aria-label", words.whereThisSits);
  const back = button("ribbon-back", "", go.up);
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "‹";
  const named = document.createElement("span");
  named.className = "ribbon-up";
  named.textContent = placed.up;
  back.append(arrow, named);
  bar.append(back);
  if (!placed.at) return;
  const at = document.createElement("span");
  at.className = "ribbon-at";
  at.textContent = words.leafOfMany(placed.at[0], placed.at[1]);
  const arrows = document.createElement("span");
  arrows.className = "ribbon-arrows";
  const { back: before, on: after } = placed;
  const sideways = (one: Cited | undefined, said: string, mark: string) => {
    const step = button("", mark, one && (() => go.to(one)));
    step.setAttribute("aria-label", said);
    step.title = one?.title ?? said;
    return step;
  };
  arrows.append(sideways(before, words.leafBack, "‹"), sideways(after, words.leafOn, "›"));
  bar.append(at, arrows);
};

// Under the sheet, the page that comes next, as Tisty offers it.
export const onward = (
  under: HTMLButtonElement,
  next: Cited | undefined,
  words: Ribboned,
  go: (one: Cited) => void,
) => {
  under.hidden = !next;
  under.replaceChildren();
  under.onclick = null;
  if (!next) return;
  const say = document.createElement("span");
  say.className = "onward-say";
  say.textContent = words.leafNext;
  const name = document.createElement("span");
  name.className = "onward-name";
  name.textContent = next.title;
  const mark = document.createElement("span");
  mark.className = "onward-go";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "›";
  under.append(say, name, mark);
  under.onclick = () => go(next);
};

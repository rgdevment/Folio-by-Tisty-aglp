import "tisty-editor/tokens.css";
import "tisty-editor/side.css";
import "./web.css";
import { type Head, heads as headsOf, sided } from "tisty-editor/read";
import init, { open, open_sheet, type Page, type Sheet } from "../wasm/tisty_share_wasm.js";
import wasm from "../wasm/tisty_share_wasm_bg.wasm?url";
import { panelsOf, signedApart } from "./beside";
import { type Cited, citedOf, citedOpening, walking } from "./cited";
import {
  drawn,
  laidOut,
  type Opened,
  type Picture,
  plain,
  titleOf,
  type View,
  viewOf,
} from "./drawn";
import {
  early,
  type Facts,
  fetched,
  limitsOf,
  REASONS,
  type Reason,
  reported,
  restOf,
} from "./fetched";
import { type About, accessOf, bylined, endsOf, otherHand, tagged, whenOf } from "./frame";
import { type Link, linkOf, readLinkOf } from "./link";
import { type Arrived, picturesOf, resting, STALE } from "./rested";
import { onward, type Placed, placedIn, type Ribboned, ribbon } from "./ribbon";
import { gated, refused, sheetWordsFor, spanish, wordsFor } from "./words";

// What the link opened: the body, its front matter's title (which wins over the first line, as in Tisty) and the text.
type Found = Opened & {
  readonly title: string;
  readonly text?: string;
  readonly about: About;
  readonly rest?: () => Promise<Arrived | string>;
};
type Read = Found & { readonly facts: Facts; readonly link: Link };
type Sealed = {
  readonly sealed: Uint8Array;
  readonly facts: Facts;
  readonly revoked?: string;
  readonly rest?: string;
};
type Ticket = { readonly id: string; readonly ticket: string };

const night = matchMedia("(prefers-color-scheme: dark)");
const inSpanish = spanish(navigator.language);
const language = inSpanish ? "es" : "en";
const say = wordsFor(inSpanish);
const sheetSays = { say: sheetWordsFor(inSpanish), language };
const part = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector) as T;
const told = part(".said");
const gate = part<HTMLFormElement>(".gate");
const reading = part(".read");
const wait = part(".wait");
const frame = part<HTMLIFrameElement>("iframe.sheet");

const themed = () => {
  document.documentElement.dataset.theme = night.matches ? "dark" : "light";
};

// The pen writes only while something is on its way; a word that says why nothing came stands alone.
const tell = (word: string) => {
  told.textContent = say(word);
  told.hidden = false;
  wait.hidden = word !== "opening";
  gate.hidden = true;
  reading.hidden = true;
};

const asked = (word: string) => {
  told.hidden = true;
  wait.hidden = true;
  reading.hidden = true;
  part(".gate-said").textContent = say(word);
  gate.hidden = false;
  const password = part<HTMLInputElement>("#password");
  // Said on the field itself, since the gate is hidden and shown again and its words may go unannounced.
  password.setAttribute("aria-invalid", String(word === "password_wrong"));
  password.focus();
};

// The sheet is laid out unseen behind the pen, and shown once it is drawn, so no empty frame shows meanwhile.
const seen = () => {
  told.hidden = true;
  gate.hidden = true;
  reading.hidden = false;
  reading.classList.add("is-drawing");
};

const drawnNow = () => {
  wait.hidden = true;
  reading.classList.remove("is-drawing");
};

const wordOf = (refused: unknown): string =>
  refused instanceof Error ? refused.message : "failed";

const drawnOf = (held: Page | Sheet, about: About) => ({
  html: held.html,
  cited: citedOf(held.cited),
  lang: about.lang,
  about,
  title: plain(about.title ?? ""),
});

// Every document is signed by whoever wrote it; one that is not never reaches the page (decision 71).
const unsigned = (about: About): string | undefined => {
  const wrote = about.wrote;
  if (!wrote) return "unsigned";
  // A signature that does not hold claims someone it is not, which is worse than none.
  return wrote.is === "refused" || wrote.is === "unreadable" ? "forged" : undefined;
};

// The page holds the words and pictures in the clear, so it is let go on every way out.
const taken = (page: Page): Found => {
  try {
    const about = JSON.parse(page.about) as About;
    const pictures = picturesOf(
      page.pictures,
      (at) => page.picture(at),
      (at) => page.media(at),
    );
    return { ...drawnOf(page, about), pictures, text: page.text };
  } finally {
    page.free();
  }
};

const sheetTaken = (sheet: Sheet, { id, ticket }: Ticket): Found | string => {
  let handed = false;
  try {
    const about = JSON.parse(sheet.about) as About;
    const refusal = unsigned(about);
    if (refusal) return refusal;
    const media = Array.from({ length: sheet.pictures }, (_, at) => sheet.media(at) ?? "");
    const rest = resting(sheet, media, () => restOf(id, ticket));
    handed = true;
    return { ...drawnOf(sheet, about), pictures: [], rest };
  } finally {
    if (!handed) sheet.free();
  }
};

const read = (
  sealed: Uint8Array,
  key: string,
  ticket?: Ticket,
  revoked?: string,
  limits?: string,
): Found | string => {
  try {
    if (ticket) return sheetTaken(open_sheet(sealed, key, revoked, limits), ticket);
    const found = taken(open(sealed, key, revoked, limits));
    return unsigned(found.about) ?? found;
  } catch (error_) {
    return wordOf(error_);
  }
};

// Only an envelope over Tisty's own limits needs the server's, so a reading mostly asks the Worker once.
const unsealed = async (link: Link, answer: Sealed): Promise<Read | string> => {
  const ticket = answer.rest === undefined ? undefined : { id: link.id, ticket: answer.rest };
  let found = read(answer.sealed, link.key, ticket, answer.revoked);
  if (found === "over") {
    const limits = await limitsOf();
    found =
      "refused" in limits
        ? limits.refused
        : read(answer.sealed, link.key, ticket, answer.revoked, limits.limits);
  }
  return typeof found === "string" ? found : { ...found, facts: answer.facts, link };
};

const opened = async (password?: string): Promise<Read | string> => {
  const link = linkOf(location.pathname, location.hash);
  if (!link) return "nolink";
  if (!link.key) return "keyless";
  // The wasm is the largest thing the page asks for, so losing it is a connection's fault, not the document's.
  const loading = init({ module_or_path: wasm }).then(
    () => true,
    () => false,
  );
  const [answer, loaded] = await Promise.all([
    fetched(link.id, early(link.id), password, checked),
    loading,
  ]);
  if ("refused" in answer) return answer.refused;
  if (!loaded) return "offline";
  return unsealed(link, answer);
};

// What can be done with it and for how long sit under the panels, as the mock-up lays them out.
const framed = (found: Read) => {
  part(".access").textContent = say(accessOf(found.facts));
  part(".ends").textContent = endsOf(found.facts, language);
};

// The paper keeps its own width: where the panels do not fit beside it, they wait under a button instead.
const fitted = (across: number) => {
  const root = document.documentElement;
  const beside = Number.parseFloat(getComputedStyle(root).getPropertyValue("--beside")) || 0;
  root.style.setProperty("--across", `${across}px`);
  root.classList.toggle("tight", innerWidth < across + beside);
};

// Going to a heading from the panels puts them away again.
const besideOpen = part<HTMLButtonElement>(".side-open");
const besideShown = (open: boolean) => {
  reading.classList.toggle("is-side", open);
  besideOpen.setAttribute("aria-expanded", String(open));
};
// On a phone this opens every panel, the signature and the expiry among them, not only the outline.
besideOpen.textContent = sheetSays.say("besideDetails");
besideOpen.addEventListener("click", () => besideShown(!reading.classList.contains("is-side")));
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && reading.classList.contains("is-side")) besideShown(false);
});

// A worker of its own for each piece of work: a page does little of it, and the work holds nothing worth keeping.
// One worker for the page's life, so a second password or a report never loads and compiles the wasm again.
let solver: Worker | null = null;
let solves: Promise<string | undefined> = Promise.resolve(undefined);

const solvedBy = (worker: Worker, challenge: string): Promise<string | undefined> =>
  new Promise((done) => {
    const heard = ({ data }: MessageEvent<string | null>) => {
      off();
      done(data ?? undefined);
    };
    // A worker that failed is let go, and the next work starts a fresh one.
    const failed = () => {
      off();
      worker.terminate();
      if (solver === worker) solver = null;
      done(undefined);
    };
    const off = () => {
      worker.removeEventListener("message", heard);
      worker.removeEventListener("error", failed);
    };
    worker.addEventListener("message", heard);
    worker.addEventListener("error", failed);
    worker.postMessage(challenge);
  });

// One piece of work at a time, so each answer is the one its challenge asked for.
const solving = (challenge: string): Promise<string | undefined> => {
  const turn = solves.then(() => {
    solver ??= new Worker(new URL("./solver.ts", import.meta.url), { type: "module" });
    return solvedBy(solver, challenge);
  });
  solves = turn;
  return turn;
};

// Work beside a password can take a few seconds, so the reader is told it is under way.
const checked = (challenge: string) => {
  tell("checking");
  return solving(challenge);
};

// The report names the document shown, which a cited one changes; each starts with the form put away.
const reportable = (idOf: () => string) => {
  const form = part<HTMLFormElement>(".report");
  const reason = part<HTMLSelectElement>("#reason");
  const detail = part<HTMLTextAreaElement>("#detail");
  const said = part(".report-said");
  // No reason is chosen for the reader: the gravest goes to the police, so it is never a default.
  const pick = new Option(say("reportpick"), "", true, true);
  pick.disabled = true;
  reason.add(pick);
  for (const one of REASONS) reason.add(new Option(say(`report_${one}`), one));
  const opener = part<HTMLButtonElement>(".report-open");
  const send = part<HTMLButtonElement>(".report-send");
  const shown = (open: boolean) => {
    form.hidden = !open;
    opener.setAttribute("aria-expanded", String(open));
    if (open) reason.focus();
    else opener.focus();
  };
  opener.addEventListener("click", () => shown(form.hidden !== false));
  part(".report-cancel").addEventListener("click", () => shown(false));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Spaces alone pass `required`, so they are cleared and the browser asks for the words again.
    if (!detail.value.trim()) {
      detail.value = "";
      form.reportValidity();
      return;
    }
    send.disabled = true;
    said.textContent = say("reporting");
    const word = await reported(idOf(), reason.value as Reason, detail.value.trim(), solving);
    said.textContent = say(word);
    send.disabled = word === "thanked" || word === "reported";
  });
  return () => {
    form.reset();
    form.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    said.textContent = "";
    send.disabled = false;
  };
};

const bar = part(".ribbon");
const under = part<HTMLButtonElement>(".onward");
const ribboned: Ribboned = {
  whereThisSits: say("whereThisSits"),
  leafBack: say("leafBack"),
  leafOn: say("leafOn"),
  leafNext: say("leafNext"),
  leafOfMany: (at, of) => sheetSays.say("leafOfMany", `${at}`, `${of}`),
};

// What the link opened and what it cites, each drawn in the same place in turn with its own panels.
const reader = async (first: Read) => {
  let root = first;
  let found: Read | null = root;
  let view = viewOf(root.about);
  let raw = false;
  let heads: Head[] = [];
  let title = root.title;
  let lay = () => {};
  let picture: (pictures: readonly Picture[]) => void = () => {};
  const rawText = part(".raw");
  const laid = () => laidOut(view, sheetSays.say);
  const across = () => fitted(laid().across);
  addEventListener("resize", () => across());
  const paneled = () => {
    if (!found) return;
    const now = found;
    const side = part(".side");
    const read = readLinkOf(location.origin, now.link);
    sided(
      side,
      sheetSays.say,
      panelsOf(
        { title, text: now.text, about: now.about, facts: now.facts, view, raw, heads },
        { onView, onRaw, onShut: () => besideShown(false) },
        { sheet: sheetSays.say, page: say, language },
        { opened: now === root ? location.href : read, read },
      ),
    );
    if (otherHand(root.about, now.about)) signedApart(side, say("otherWriter"));
  };
  const onView = (next: View) => {
    view = next;
    across();
    lay();
    paneled();
  };
  const onRaw = (on: boolean) => {
    raw = on;
    frame.hidden = on;
    rawText.hidden = !on;
    if (!on) lay();
    paneled();
  };
  const unreported = reportable(() => (found ?? root).link.id);
  const ys: number[] = [];
  const walk = walking<Cited | null>(null, history, (one, at) => {
    show(one, at).catch(() => tell("failed"));
  });
  // Each step remembers the one it hangs from: a page's sisters hang from the same document as the page.
  const ups: number[] = [0];
  const reads: Read[] = [];
  // The name each step was shown under, its drawn heading when it says no title.
  const named: string[] = [];
  const stepped = (one: Cited, up: number) => {
    ys[walk.at()] = scrollY;
    ups.length = walk.at() + 1;
    ups.push(up);
    walk.went(one);
  };
  const opening = (one: Cited) => stepped(one, walk.at());
  const sideways = (one: Cited) => stepped(one, ups[walk.at()] ?? 0);
  const placed = (one: Cited | null, at: number): Placed | null => {
    const from = reads[ups[at] ?? 0];
    if (!one || at === 0 || !from) return null;
    return placedIn(one, named[ups[at] ?? 0] || say("document"), from.cited);
  };
  // A document that could not be opened still has its way back to the one above.
  const placeBar = (one: Cited | null, at: number, opened: boolean) => {
    const where = placed(one, at);
    ribbon(bar, where, ribboned, {
      up: () => walk.up(ups[at] ?? 0),
      to: sideways,
    });
    onward(under, opened ? where?.on : undefined, ribboned, sideways);
  };
  // Tags and dates sit under the body's title; a body without one has them above it instead.
  const draw = async () => {
    const now = found;
    if (!now) return;
    across();
    const when = whenOf(now.facts, now.about.version ?? 1, Date.now() / 1000, language, say);
    const tags = now.about.tags ?? [];
    const shown = await drawn(
      frame,
      now,
      night.matches,
      { ...sheetSays, stays: say("fileStays") },
      laid,
      opening,
    );
    lay = shown.lay;
    picture = shown.picture;
    const { page } = shown;
    const inside = bylined(page, tags, when);
    tagged(part(".tags"), inside ? [] : tags);
    part(".when").textContent = inside ? "" : when;
    part(".paper-head").hidden = inside || (tags.length === 0 && !when);
    heads = headsOf(page).map((one) => ({
      ...one,
      go: () => {
        besideShown(false);
        one.go();
      },
    }));
    title ||= titleOf(page);
    paneled();
  };
  const put = async (next: Read) => {
    found = next;
    view = viewOf(next.about);
    raw = false;
    heads = [];
    title = next.title;
    lay = () => {};
    picture = () => {};
    rawText.textContent = next.text ?? "";
    rawText.hidden = true;
    frame.hidden = false;
    besideShown(false);
    seen();
    await draw();
    drawnNow();
    frame.title = title || say("document");
    document.title = title ? `${title} · Tisty` : "Tisty";
    besideOpen.hidden = false;
    framed(next);
    unreported();
  };
  // One drawing at a time, so two quick changes of theme or of document never draw into the same sheet.
  let drawing = Promise.resolve();
  const queued = (job: () => Promise<void>) => {
    drawing = drawing.then(job).then(
      () => undefined,
      () => tell("failed"),
    );
    return drawing;
  };
  const arrive = async (shown: Read, stale: () => void) => {
    const arrived = await shown.rest?.();
    if (arrived === undefined) return;
    if (typeof arrived === "string") {
      if (STALE.has(arrived) && found === shown) stale();
      return;
    }
    await queued(async () => {
      if (found !== shown) return;
      found = { ...shown, ...arrived };
      picture(arrived.pictures);
      rawText.textContent = arrived.text;
      paneled();
    });
  };
  const openCited = citedOpening<Read>((one, answer) =>
    unsealed({ id: one.id, key: one.key }, answer),
  );
  // Only the last step asked for is shown, however the ones before it arrive.
  let turn = 0;
  const show = async (one: Cited | null, at: number) => {
    turn += 1;
    const mine = turn;
    if (one) tell("opening");
    const next = one ? await openCited(one) : root;
    if (mine !== turn) return;
    if (typeof next === "string") {
      placeBar(one, at, false);
      found = null;
      besideShown(false);
      besideOpen.hidden = true;
      tell(next);
      scrollTo({ top: 0 });
      return;
    }
    reads[at] = next;
    await queued(async () => {
      if (mine !== turn) return;
      await put(next);
      named[at] = title;
      placeBar(one, at, true);
      scrollTo({ top: ys[at] ?? 0 });
    });
    if (found === next)
      void arrive(next, () => {
        renewed(one, at).catch(() => tell("failed"));
      });
  };
  const renewing = new Set<string>();
  const renewed = async (one: Cited | null, at: number) => {
    const id = one?.id ?? root.link.id;
    if (renewing.has(id)) return;
    renewing.add(id);
    if (one) {
      openCited.forget(one.id);
      return show(one, at);
    }
    const answer = await fetched(root.link.id);
    const fresh = "refused" in answer ? answer.refused : await unsealed(root.link, answer);
    if (typeof fresh === "string" || found?.link.id !== id) return;
    root = fresh;
    return show(null, 0);
  };
  // The page puts each step back where the reader left it, once its document is drawn again.
  history.scrollRestoration = "manual";
  // A reload opens the shared document, so this entry becomes its own rather than a step memory no longer holds.
  history.replaceState({ at: 0 }, "");
  addEventListener("popstate", ({ state }) => {
    ys[walk.at()] = scrollY;
    walk.popped(state);
  });
  await show(null, 0);
  night.addEventListener("change", () => {
    themed();
    void queued(draw);
  });
};

const shown = async (password?: string) => {
  tell("opening");
  const found = await opened(password);
  if (typeof found === "string") {
    if (gated(found)) return asked(found);
    return refused(found, (to) => location.replace(to), tell);
  }
  await reader(found);
};

document.documentElement.lang = language;
for (const one of document.querySelectorAll<HTMLElement>("[data-word]"))
  one.textContent = say(one.dataset.word ?? "");
themed();

// The button stays off while a password is tried, so a second Enter never frames the page twice.
gate.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = part<HTMLInputElement>("#password");
  const open = part<HTMLButtonElement>(".gate button");
  open.disabled = true;
  shown(password.value)
    .catch(() => tell("failed"))
    .finally(() => {
      open.disabled = false;
    });
  password.value = "";
});

// Another key pasted over this one is another link, so it is read anew.
addEventListener("hashchange", () => location.reload());

// A body that would not draw says so, rather than leaving half a sheet without a word.
await shown().catch(() => tell("failed"));

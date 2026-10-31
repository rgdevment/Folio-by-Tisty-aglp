import "tisty-editor/tokens.css";
import "tisty-editor/side.css";
import "./web.css";
import { type Head, heads as headsOf, sided } from "tisty-editor/read";
import init, { open, type Page } from "../wasm/tisty_share_wasm.js";
import wasm from "../wasm/tisty_share_wasm_bg.wasm?url";
import { panelsOf } from "./beside";
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
import { type Facts, fetched, limitsOf, REASONS, type Reason, reported } from "./fetched";
import { type About, accessOf, bylined, endsOf, tagged, whenOf } from "./frame";
import { type Link, linkOf, readLinkOf } from "./link";
import { gated, refused, sheetWordsFor, spanish, wordsFor } from "./words";

// What the link opened: the body, its front matter's title (which wins over the first line, as in Tisty) and the text.
type Found = Opened & { readonly title: string; readonly text: string; readonly about: About };
type Read = Found & { readonly facts: Facts; readonly link: Link };

const night = matchMedia("(prefers-color-scheme: dark)");
const inSpanish = spanish(navigator.language);
const language = inSpanish ? "es" : "en";
const say = wordsFor(inSpanish);
const sheetSays = { say: sheetWordsFor(inSpanish), language };
const part = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector) as T;
const told = part(".said");
const gate = part<HTMLFormElement>(".gate");
const reading = part(".read");
const frame = part<HTMLIFrameElement>("iframe.sheet");

const themed = () => {
  document.documentElement.dataset.theme = night.matches ? "dark" : "light";
};

const tell = (word: string) => {
  told.textContent = say(word);
  told.hidden = false;
  gate.hidden = true;
  reading.hidden = true;
};

const asked = (word: string) => {
  told.hidden = true;
  reading.hidden = true;
  part(".gate-said").textContent = say(word);
  gate.hidden = false;
  part<HTMLInputElement>("#password").focus();
};

const seen = () => {
  told.hidden = true;
  gate.hidden = true;
  reading.hidden = false;
};

const wordOf = (refused: unknown): string =>
  refused instanceof Error ? refused.message : "failed";

// The page holds the words and pictures in the clear, so it is let go on every way out.
const taken = (page: Page): Found => {
  try {
    const about = JSON.parse(page.about) as About;
    const pictures: Picture[] = Array.from({ length: page.pictures }, (_, at) => ({
      // wasm-bindgen hands each picture over in a buffer of its own, never a shared one.
      bytes: (page.picture(at) ?? new Uint8Array()) as Uint8Array<ArrayBuffer>,
      media: page.media(at) ?? "",
    }));
    return {
      html: page.html,
      pictures,
      text: page.text,
      about,
      title: plain(about.title ?? ""),
    };
  } finally {
    page.free();
  }
};

// Every document is signed by whoever wrote it; one that is not never reaches the page (decision 71).
const read = (
  sealed: Uint8Array,
  key: string,
  revoked?: string,
  limits?: string,
): Found | string => {
  try {
    const found = taken(open(sealed, key, revoked, limits));
    const wrote = found.about.wrote;
    if (!wrote) return "unsigned";
    // A signature that does not hold claims someone it is not, which is worse than none.
    return wrote.is === "refused" || wrote.is === "unreadable" ? "forged" : found;
  } catch (error_) {
    return wordOf(error_);
  }
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
  const [answer, loaded] = await Promise.all([fetched(link.id, fetch, password, checked), loading]);
  if ("refused" in answer) return answer.refused;
  if (!loaded) return "offline";
  let found = read(answer.sealed, link.key, answer.revoked);
  // Only an envelope over Tisty's own limits needs the server's, so a reading mostly asks the Worker once.
  if (found === "over") {
    const limits = await limitsOf();
    found =
      "refused" in limits
        ? limits.refused
        : read(answer.sealed, link.key, answer.revoked, limits.limits);
  }
  return typeof found === "string" ? found : { ...found, facts: answer.facts, link };
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
besideOpen.textContent = sheetSays.say("outline");
besideOpen.addEventListener("click", () => besideShown(!reading.classList.contains("is-side")));
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && reading.classList.contains("is-side")) besideShown(false);
});

// A worker of its own for each piece of work: a page does little of it, and the work holds nothing worth keeping.
const solving = (challenge: string): Promise<string | undefined> =>
  new Promise((done) => {
    const solver = new Worker(new URL("./solver.ts", import.meta.url), { type: "module" });
    const finished = (work?: string) => {
      solver.terminate();
      done(work);
    };
    solver.addEventListener("message", ({ data }: MessageEvent<string | null>) =>
      finished(data ?? undefined),
    );
    solver.addEventListener("error", () => finished());
    solver.postMessage(challenge);
  });

// Work beside a password can take a few seconds, so the reader is told it is under way.
const checked = (challenge: string) => {
  tell("checking");
  return solving(challenge);
};

const reportable = (id: string) => {
  const form = part<HTMLFormElement>(".report");
  const reason = part<HTMLSelectElement>("#reason");
  const detail = part<HTMLTextAreaElement>("#detail");
  const said = part(".report-said");
  // No reason is chosen for the reader: the gravest goes to the police, so it is never a default.
  const pick = new Option(say("reportpick"), "", true, true);
  pick.disabled = true;
  reason.add(pick);
  for (const one of REASONS) reason.add(new Option(say(`report_${one}`), one));
  part(".report-open").addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  part(".report-cancel").addEventListener("click", () => {
    form.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Spaces alone pass `required`, so they are cleared and the browser asks for the words again.
    if (!detail.value.trim()) {
      detail.value = "";
      form.reportValidity();
      return;
    }
    const send = part<HTMLButtonElement>(".report-send");
    send.disabled = true;
    said.textContent = say("reporting");
    const word = await reported(id, reason.value as Reason, detail.value.trim(), solving);
    said.textContent = say(word);
    send.disabled = word === "thanked" || word === "reported";
  });
};

const shown = async (password?: string) => {
  tell("opening");
  const found = await opened(password);
  if (typeof found === "string") {
    if (gated(found)) return asked(found);
    return refused(found, (to) => location.replace(to), tell);
  }
  const when = whenOf(found.facts, found.about.version ?? 1, Date.now() / 1000, language, say);
  const tags = found.about.tags ?? [];
  let view = viewOf(found.text);
  let raw = false;
  let heads: Head[] = [];
  let title = found.title;
  let lay = () => {};
  const rawText = part(".raw");
  rawText.textContent = found.text;
  const laid = () => laidOut(view, sheetSays.say);
  const across = () => fitted(laid().across);
  addEventListener("resize", () => across());
  const paneled = () =>
    sided(
      part(".side"),
      sheetSays.say,
      panelsOf(
        { title, text: found.text, about: found.about, view, raw, heads },
        { onView, onRaw, onShut: () => besideShown(false) },
        { sheet: sheetSays.say, page: say, language },
        { opened: location.href, read: readLinkOf(location.origin, found.link) },
      ),
    );
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
  // Tags and dates sit under the body's title; a body without one has them above it instead.
  const draw = async () => {
    seen();
    across();
    const shown = await drawn(frame, found, night.matches, sheetSays, laid);
    lay = shown.lay;
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
  // One drawing at a time, so two quick changes of theme never draw into the same sheet.
  let drawing = Promise.resolve();
  await draw();
  frame.title = title || say("document");
  if (title) document.title = `${title} · Tisty`;
  besideOpen.hidden = false;
  framed(found);
  reportable(linkOf(location.pathname, location.hash)?.id ?? "");
  night.addEventListener("change", () => {
    themed();
    drawing = drawing.then(draw).then(
      () => undefined,
      () => tell("failed"),
    );
  });
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

import "tisty-reader/tokens.css";
import "./web.css";
import init, { open, type Page } from "../wasm/tisty_share_wasm.js";
import wasm from "../wasm/tisty_share_wasm_bg.wasm?url";
import { drawn, type Opened, type Picture, plain, titleOf } from "./drawn";
import { fetched, limitsOf } from "./fetched";
import { linkOf } from "./link";
import { refused, spanish, wordsFor } from "./words";

type About = { title?: string | null };
// What the link opened, with the title its front matter gives, which wins over the first line as in Tisty.
type Found = Opened & { readonly title: string };

const night = matchMedia("(prefers-color-scheme: dark)");
const inSpanish = spanish(navigator.language);
const say = wordsFor(inSpanish);
const told = document.querySelector<HTMLElement>(".said") as HTMLElement;
const frame = document.querySelector<HTMLIFrameElement>("iframe.sheet") as HTMLIFrameElement;
const notices = document.querySelector<HTMLElement>(".notices") as HTMLElement;

const themed = () => {
  document.documentElement.dataset.theme = night.matches ? "dark" : "light";
};

const tell = (word: string) => {
  told.textContent = say(word);
  told.hidden = false;
  frame.hidden = true;
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
    return { html: page.html, pictures, title: plain(about.title ?? "") };
  } finally {
    page.free();
  }
};

const read = (sealed: Uint8Array, key: string, limits?: string): Found | string => {
  try {
    return taken(open(sealed, key, limits));
  } catch (error_) {
    return wordOf(error_);
  }
};

const opened = async (): Promise<Found | string> => {
  const link = linkOf(location.pathname, location.hash);
  if (!link) return "nolink";
  if (!link.key) return "keyless";
  // The wasm is the largest thing the page asks for, so losing it is a connection's fault, not the document's.
  const loading = init({ module_or_path: wasm }).then(
    () => true,
    () => false,
  );
  const [answer, loaded] = await Promise.all([fetched(link.id), loading]);
  if ("refused" in answer) return answer.refused;
  if (!loaded) return "offline";
  const found = read(answer.sealed, link.key);
  if (found !== "over") return found;
  // Only an envelope over Tisty's own limits needs the server's, so a reading mostly asks the Worker once.
  const limits = await limitsOf();
  return "refused" in limits ? limits.refused : read(answer.sealed, link.key, limits.limits);
};

const seen = () => {
  told.hidden = true;
  frame.hidden = false;
};

const shown = async () => {
  document.documentElement.lang = inSpanish ? "es" : "en";
  notices.textContent = say("notices");
  themed();
  tell("opening");
  const found = await opened();
  if (typeof found === "string") return refused(found, (to) => location.replace(to), tell);
  const draw = () => {
    seen();
    return drawn(frame, found, night.matches, say);
  };
  const page = await draw();
  const title = found.title || titleOf(page);
  frame.title = title || say("document");
  if (title) document.title = `${title} · Tisty`;
  // One drawing at a time, so two quick changes of theme never draw into the same sheet.
  let drawing = Promise.resolve();
  night.addEventListener("change", () => {
    themed();
    drawing = drawing.then(draw).then(
      () => undefined,
      () => tell("failed"),
    );
  });
};

// Another key pasted over this one is another link, so it is read anew.
addEventListener("hashchange", () => location.reload());

// A body that would not draw says so, rather than leaving half a sheet without a word.
await shown().catch(() => tell("failed"));

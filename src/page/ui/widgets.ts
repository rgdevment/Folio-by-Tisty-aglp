import { checkWidget, strayInWidget, WIDGET, widgetPage } from "@tisty/contracts/check";

// The page's own policy would strip a srcdoc of its styles, so the frame gets a page served under the widget's policy.
const EMPTY_PAGE = "/widget-frame";
const SHORTEST = 40;
const TALLEST = 2400;
const CLIMBS_AT_MOST = 3;
const CLIMBS_WITHIN = 250;
const WRONG_SHOWN_AT_MOST = 3;

const NOT_A_WIDGET = "Este bloque no es un widget y por eso se muestra como código: ";
const ONLY_HTML_AND_CSS = "Un widget es solo HTML y CSS, sin nada que se ejecute ni venga de afuera.";
const TOO_BIG = `Un widget puede tener hasta ${Math.round(WIDGET.bytes / 1000)} KB; este pasa de ahí, así que se muestra como código.`;

const whyNotDrawn = (source: string): string | null => {
  if (new TextEncoder().encode(source).length > WIDGET.bytes) return TOO_BIG;
  const wrong = [...new Set([...checkWidget(source), ...strayInWidget(source)])];
  return wrong.length ? `${NOT_A_WIDGET}${wrong.slice(0, WRONG_SHOWN_AT_MOST).join(", ")}. ${ONLY_HTML_AND_CSS}` : null;
};

const sizing = (frame: HTMLIFrameElement) => {
  let climbed = 0;
  let stride = 0;
  let climbedAt = Number.NEGATIVE_INFINITY;
  return (height: number): void => {
    const next = Math.min(TALLEST, Math.max(SHORTEST, Math.ceil(height)));
    const step = next - (Number.parseFloat(frame.style.height) || SHORTEST);
    if (step > 0) {
      const now = Date.now();
      climbed = step === stride && now - climbedAt < CLIMBS_WITHIN ? climbed + 1 : 1;
      stride = step;
      climbedAt = now;
      if (climbed >= CLIMBS_AT_MOST) return;
    } else {
      climbed = 0;
      stride = 0;
    }
    frame.style.height = `${next}px`;
  };
};

const hostOf = (frame: HTMLIFrameElement): HTMLElement | undefined =>
  (frame.getRootNode() as ShadowRoot).host as HTMLElement | undefined;

const followTheme = (frame: HTMLIFrameElement, inside: globalThis.Document, host: HTMLElement): void => {
  const themes = new MutationObserver(() => {
    if (!frame.isConnected) {
      themes.disconnect();
      return;
    }
    const dark = host.dataset.theme === "dark";
    inside.documentElement.classList.toggle("dark", dark);
    frame.style.colorScheme = dark ? "dark" : "light";
  });
  themes.observe(host, { attributes: true, attributeFilter: ["data-theme"] });
};

const written = (frame: HTMLIFrameElement, source: string): void => {
  const inside = frame.contentDocument;
  if (!inside) return;
  const host = hostOf(frame);
  const dark = host?.dataset.theme === "dark";
  inside.open();
  inside.write(widgetPage(source, dark));
  inside.close();
  frame.style.colorScheme = dark ? "dark" : "light";
  if (host) followTheme(frame, inside, host);
  const box = inside.querySelector("main.w");
  if (!box) return;
  const grow = sizing(frame);
  const sizes = new ResizeObserver(() => {
    if (!frame.isConnected) {
      sizes.disconnect();
      return;
    }
    grow(Math.max(box.scrollHeight, box.getBoundingClientRect().height));
  });
  sizes.observe(box);
};

const framed = (page: globalThis.Document, name: string, source: string): HTMLIFrameElement => {
  const frame = page.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = name || "Widget";
  frame.style.height = `${SHORTEST}px`;
  frame.addEventListener("load", () => written(frame, source), { once: true });
  frame.src = EMPTY_PAGE;
  return frame;
};

export const drawWidgets = (words: DocumentFragment): void => {
  for (const code of words.querySelectorAll("figure.code > pre > code.language-widget")) {
    const source = code.textContent ?? "";
    const figure = code.closest("figure") as Element;
    const page = figure.ownerDocument;
    const why = whyNotDrawn(source);
    if (why) {
      const said = page.createElement("p");
      said.className = "widget-said";
      said.textContent = why;
      figure.before(said);
      continue;
    }
    const name = figure.querySelector("figcaption")?.textContent ?? "";
    const drawn = page.createElement("figure");
    drawn.className = "widget";
    if (name) {
      const caption = page.createElement("figcaption");
      caption.textContent = name;
      drawn.append(caption);
    }
    drawn.append(framed(page, name, source));
    figure.replaceWith(drawn);
  }
};

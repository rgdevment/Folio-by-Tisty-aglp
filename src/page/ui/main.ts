import "virtual:tisty-tokens.css";
import "./frame.css";
import { askFor } from "./ask";

const ID_PATH = /^\/[A-Za-z0-9]{8}$/;
const NOT_FOUND = "https://www.tisty.app/404";

const showSample = async (): Promise<void> => {
  const [{ SAMPLE, SAMPLE_SEAL }, { drawFrame }, { domPurifyCleaner }] = await Promise.all([
    import("../sample"),
    import("./frame"),
    import("./clean"),
  ]);
  const cleaner = domPurifyCleaner(window);
  drawFrame(SAMPLE, (html) => cleaner.clean(html), SAMPLE_SEAL);
};

const showAsked = async (id: string): Promise<void> => {
  // Asked first, and the rest of the code after, so neither waits for the other.
  const asked = askFor(id);
  const { showLink } = await import("./show");
  await showLink(id, location.hash.slice(1), asked, NOT_FOUND);
};

if (import.meta.env.MODE !== "production") {
  await showSample();
} else if (ID_PATH.test(location.pathname)) {
  await showAsked(location.pathname.slice(1));
} else {
  location.replace(NOT_FOUND);
}

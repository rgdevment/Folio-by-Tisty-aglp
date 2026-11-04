import "virtual:tisty-tokens.css";
import "./frame.css";
import { drawClosed, drawFrame } from "./frame";

const ID_PATH = /^\/[A-Za-z0-9]{8}$/;
const NOT_FOUND = "https://www.tisty.app/404";

const showSample = async (): Promise<void> => {
  const { SAMPLE, SAMPLE_SEAL } = await import("../sample");
  const template = document.createElement("template");
  template.innerHTML = SAMPLE.html;
  drawFrame(SAMPLE, template.content, SAMPLE_SEAL);
};

if (import.meta.env.MODE !== "production") {
  await showSample();
} else if (ID_PATH.test(location.pathname)) {
  drawClosed("Folio todavía no abre documentos.");
} else {
  location.replace(NOT_FOUND);
}

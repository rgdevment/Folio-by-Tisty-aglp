import init, { solved } from "../wasm/folio_wasm.js";
import wasm from "../wasm/folio_wasm_bg.wasm?url";

// The work lasts as long as the server's challenge asks, so it runs here and the page never stops answering.
const loaded = init({ module_or_path: wasm });

addEventListener("message", async ({ data }: MessageEvent<string>) => {
  await loaded;
  postMessage(solved(data) ?? null);
});

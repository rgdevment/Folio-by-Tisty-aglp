// What a link asks for before it shows anything, as Cloudflare sends it, so a static import fails here, not on a phone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const DIST = "dist";
// The page's own code with DOMPurify; 40 KB once the show door leaves the read door behind (task 4b-5).
const SCRIPT_AT_MOST = 48 * 1024;
const WASM_AT_MOST = 200 * 1024;

const sent = (file) =>
  brotliCompressSync(readFileSync(join(DIST, file)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  }).length;

const html = readFileSync(join(DIST, "index.html"), "utf8");
const asked = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\/([^"]+)"[^>]*>/g)]
  .filter(([tag]) => !/rel="(?:icon|apple-touch-icon|manifest)"/.test(tag))
  .map(([, file]) => file);
const weight = (pick) => asked.filter(pick).reduce((sum, file) => sum + sent(file), 0);

const scripts = weight((file) => file.endsWith(".js"));
const wasm = weight((file) => file.endsWith(".wasm"));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
for (const file of asked) console.log(`${file}  ${kb(sent(file))}`);
console.log(`scripts ${kb(scripts)} of ${kb(SCRIPT_AT_MOST)}, wasm ${kb(wasm)} of ${kb(WASM_AT_MOST)}`);

const over = [
  scripts > SCRIPT_AT_MOST && `the scripts asked for up front weigh ${kb(scripts)}`,
  wasm > WASM_AT_MOST && `the wasm asked for up front weighs ${kb(wasm)}`,
  wasm === 0 && "no wasm is asked for up front, so the page would wait for its script to ask",
].filter(Boolean);
if (over.length > 0) {
  for (const one of over) console.error(`::error::${one}`);
  process.exit(1);
}

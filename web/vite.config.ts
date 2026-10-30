import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Stryker runs the tests from a copy of the page, so the packages are looked for up the folders.
const packageAt = (name: string, from: string): string => {
  const here = join(from, "packages", name);
  if (existsSync(here)) return here;
  const up = dirname(from);
  if (up === from) throw new Error(`packages/${name} is not above the page`);
  return packageAt(name, up);
};
const pageAt = dirname(fileURLToPath(import.meta.url));
const reader = packageAt("tisty-reader", pageAt);
const studio = packageAt("tisty-diagrams", pageAt);
const root = dirname(dirname(reader));

// The libraries the page carries ask that their notices travel with every copy, so Tisty's own go along.
const notices: Plugin = {
  name: "notices",
  apply: "build",
  generateBundle() {
    for (const [from, to] of [
      ["THIRD-PARTY-BUNDLED.md", "third-party.txt"],
      ["THIRD-PARTY-LICENSES.md", "third-party-licenses.txt"],
    ])
      this.emitFile({
        type: "asset",
        fileName: to,
        source: readFileSync(join(root, from), "utf8"),
      });
  },
};

export default defineConfig({
  plugins: [notices],
  resolve: {
    alias: { "tisty-diagrams": join(studio, "src"), "tisty-reader": join(reader, "src") },
  },
  build: {
    // The wasm loads as a file of its own, so the page's CSP never has to let a script be built from a string.
    assetsInlineLimit: 0,
    target: "es2022",
  },
  server: { fs: { allow: [".", reader, studio, join(root, "assets")] } },
  // The proof of work's worker imports the wasm as the page does, which only a module worker can.
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});

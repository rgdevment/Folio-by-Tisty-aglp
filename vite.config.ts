import { readFileSync } from "node:fs";
import { CONTRACTS } from "@tisty/contracts";
import { defineConfig, type Plugin } from "vite";

const TOKENS = "virtual:tisty-tokens.css";
const RESOLVED_TOKENS = `\0${TOKENS}`;

interface StyleValues {
  colors: { light: Record<string, string>; dark: Record<string, string> };
}

const variables = ({ light, dark }: StyleValues["colors"]): string =>
  Object.entries(light)
    .map(([name, value]) => `--tisty-${name}:light-dark(${value},${dark[name]});`)
    .join("");

// The colors come from the contract when building, so they change with it and no copy of them is kept here.
const tokens = (): Plugin => ({
  name: "tisty-tokens",
  resolveId: (id) => (id === TOKENS ? RESOLVED_TOKENS : null),
  load(id) {
    if (id !== RESOLVED_TOKENS) return null;
    const { colors } = (CONTRACTS.style as { values: StyleValues }).values;
    return `:root{${variables(colors)}}`;
  },
});

const dompurifyFile = (name: string): string => readFileSync(`node_modules/dompurify/${name}`, "utf8");

// DOMPurify travels minified in what every reader downloads, and both its licenses ask for their notices to go with it.
const licenses = (): Plugin => ({
  name: "folio-licenses",
  generateBundle() {
    const { version } = JSON.parse(dompurifyFile("package.json")) as { version: string };
    this.emitFile({
      type: "asset",
      fileName: "licenses.txt",
      source: `DOMPurify ${version}, (c) Cure53 and other contributors\nUnder Apache-2.0 or MPL-2.0, at your choice.\nSource: https://github.com/cure53/DOMPurify\n\n${dompurifyFile("LICENSE")}\n${dompurifyFile("LICENSE-MPL")}`,
    });
  },
});

export default defineConfig({
  root: "src/page",
  plugins: [tokens(), licenses()],
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});

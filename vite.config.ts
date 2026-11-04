import { CONTRACTS } from "@tisty/contracts";
import { defineConfig, type Plugin } from "vite";

const TOKENS = "virtual:tisty-tokens.css";
const RESOLVED_TOKENS = `\0${TOKENS}`;

interface StyleValues {
  colors: { light: Record<string, string>; dark: Record<string, string> };
}

const variables = (colors: Record<string, string>): string =>
  Object.entries(colors)
    .map(([name, value]) => `--tisty-${name}:${value};`)
    .join("");

// The colors come from the contract when building, so they change with it and no copy of them is kept here.
const tokens = (): Plugin => ({
  name: "tisty-tokens",
  resolveId: (id) => (id === TOKENS ? RESOLVED_TOKENS : null),
  load(id) {
    if (id !== RESOLVED_TOKENS) return null;
    const { colors } = (CONTRACTS.style as { values: StyleValues }).values;
    return `:root{${variables(colors.light)}}@media (prefers-color-scheme:dark){:root{${variables(colors.dark)}}}`;
  },
});

export default defineConfig({
  root: "src/page",
  plugins: [tokens()],
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});

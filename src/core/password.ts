import { sameText, toBase64Url } from "./start";

// Decision 114: what a Worker can afford per guess. The cost travels with the hash, so it can rise without a migration.
const TURNS = 40_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

const derive = async (password: string, salt: Uint8Array, turns: number): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: turns },
    key,
    HASH_BITS,
  );
  return toBase64Url(bits);
};

const fromBase64Url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (one) => one.charCodeAt(0));

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2$${TURNS}$${toBase64Url(salt)}$${await derive(password, salt, TURNS)}`;
};

export const passwordHolds = async (stored: string, password: string): Promise<boolean> => {
  const [, turns, salt, hash] = stored.split("$");
  if (!turns || !salt || !hash) return false;
  return sameText(await derive(password, fromBase64Url(salt), Number(turns)), hash);
};

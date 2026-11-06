import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEVEL_ONE, publishedLimits } from "../src/core/limits.ts";

const LIMITS_FILE = resolve(fileURLToPath(new URL("../docs/limits.json", import.meta.url)));
const PUBLIC_KEY_FILE = resolve(fileURLToPath(new URL("../docs/limits.pub", import.meta.url)));
const SECONDS_IN_A_DAY = 86_400;
const HALTED_DAYS_AT_MOST = 7;
const KEY_ID_BYTES = 8;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const ALGORITHM_BYTES = 2;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const publicKeyFrom = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });

const blake2b = (said: Buffer): Buffer => createHash("blake2b512").update(said).digest();

export const minisignKey = (raw: Buffer): string => {
  const id = createHash("sha256").update(raw).digest().subarray(0, KEY_ID_BYTES);
  return Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
};

export const newKeys = (): { secret: string; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-KEY_BYTES);
  return {
    secret: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: minisignKey(Buffer.from(raw)),
  };
};

export const signedFile = (said: Buffer, name: string, secret: string, now: number): string => {
  const key = createPrivateKey({ key: Buffer.from(secret, "base64url"), format: "der", type: "pkcs8" });
  const raw = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-KEY_BYTES);
  const keyPart = Buffer.from(minisignKey(Buffer.from(raw)), "base64").subarray(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES);
  const signature = sign(null, blake2b(said), key);
  const trusted = `timestamp:${Math.floor(now / 1000)}\tfile:${name}\thashed`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key);
  return [
    "untrusted comment: signature from the key of Folio's limits",
    Buffer.concat([Buffer.from("ED"), keyPart, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
    "",
  ].join("\n");
};

export const holdsSignature = (said: Buffer, signatureFile: string, publicKey: string, name?: string): boolean => {
  const [, signed, trustedLine, global] = signatureFile.split(/\r?\n/);
  const key = Buffer.from(publicKey.trim(), "base64");
  const signature = Buffer.from(signed ?? "", "base64");
  const trustedPrefix = "trusted comment: ";
  if (!trustedLine?.startsWith(trustedPrefix) || !global) return false;
  if (key.length !== ALGORITHM_BYTES + KEY_ID_BYTES + KEY_BYTES) return false;
  if (signature.length !== ALGORITHM_BYTES + KEY_ID_BYTES + SIGNATURE_BYTES) return false;
  if (signature.subarray(0, ALGORITHM_BYTES).toString() !== "ED") return false;
  const idOf = (bytes: Buffer) => bytes.subarray(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES);
  if (!idOf(key).equals(idOf(signature))) return false;
  const trusted = trustedLine.slice(trustedPrefix.length);
  if (name !== undefined && !trusted.split(/\s+/).includes(`file:${name}`)) return false;
  const verifier = publicKeyFrom(key.subarray(ALGORITHM_BYTES + KEY_ID_BYTES));
  const bare = signature.subarray(ALGORITHM_BYTES + KEY_ID_BYTES);
  return (
    verify(null, blake2b(said), verifier, bare) &&
    verify(null, Buffer.concat([bare, Buffer.from(trusted)]), verifier, Buffer.from(global, "base64"))
  );
};

const serialNow = (): number =>
  existsSync(LIMITS_FILE) ? (JSON.parse(readFileSync(LIMITS_FILE, "utf8")) as { serial: number }).serial : 0;

const create = (keyFile: string): void => {
  const { secret, publicKey } = newKeys();
  writeFileSync(keyFile, `${secret}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(PUBLIC_KEY_FILE, `${publicKey}\n`);
  console.log(publicKey);
};

const write = (keyFile: string, haltedDays?: string): void => {
  const days = haltedDays === undefined ? 0 : Number(haltedDays);
  if (!Number.isInteger(days) || days < 0 || days > HALTED_DAYS_AT_MOST) {
    throw new Error(`uploads halt for 0 to ${HALTED_DAYS_AT_MOST} whole days`);
  }
  const now = Date.now();
  const halted = days > 0 ? { uploads_halted_until: Math.floor(now / 1000) + days * SECONDS_IN_A_DAY } : {};
  const said = Buffer.from(`${JSON.stringify({ serial: serialNow() + 1, ...publishedLimits(LEVEL_ONE), ...halted }, null, 2)}\n`);
  const signature = signedFile(said, basename(LIMITS_FILE), readFileSync(keyFile, "utf8").trim(), now);
  writeFileSync(LIMITS_FILE, said);
  writeFileSync(`${LIMITS_FILE}.minisig`, signature);
  console.log(`signed ${LIMITS_FILE}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [what, keyFile, haltedDays] = process.argv.slice(2);
  if (what === "new" && keyFile) create(keyFile);
  else if (what === "sign" && keyFile) write(keyFile, haltedDays);
  else console.error("node scripts/limits-key.ts new <file> | sign <file> [days uploads halt]");
}

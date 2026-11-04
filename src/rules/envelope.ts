import type { Envelope, EnvelopeKind, Opening, Signature } from "@tisty/contracts";
import { check, VERSION } from "@tisty/contracts/check";
import { bigEndian, fromBase64Url, joined, sameBytes, sha256, words } from "../core/bytes";

export type EnvelopeRefusal = "newer" | "older" | "damaged" | "unsigned" | "key";

export class EnvelopeRefused extends Error {
  readonly refusal: EnvelopeRefusal;

  constructor(refusal: EnvelopeRefusal, says: string) {
    super(says);
    this.refusal = refusal;
  }
}

export const refuse = (refusal: EnvelopeRefusal, says: string): never => {
  throw new EnvelopeRefused(refusal, says);
};

export type Asked = Pick<Opening, "id" | "kind">;

export interface ReadEnvelope {
  manifest: Envelope;
  manifestBytes: Uint8Array;
  signature: Signature;
  index: Uint8Array;
  parts: Uint8Array[];
}

const MARK = words("TENV");
const HASH_BYTES = 32;
const MANIFEST_BYTES_AT_MOST = 16384;
const SIGNATURE_BYTES_AT_MOST = 2048;
const LENGTH_BYTES = 4;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
export const jsonIn = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T;

const majorOf = (version: string): number => Number(version.split(".")[0]);

// Read first of all: a newer version may say what this one would call damaged (decision 95).
const weighVersion = (said: unknown): void => {
  if (typeof said !== "string") refuse("damaged", "it says no version");
  const version = said as string;
  if (version.includes("-") || VERSION.includes("-")) {
    if (version !== VERSION) refuse("older", `a draft opens only under itself: ${version}`);
    return;
  }
  if (!Number.isInteger(majorOf(version))) refuse("damaged", `not a version: ${version}`);
  if (majorOf(version) > majorOf(VERSION)) refuse("newer", `written under a newer version: ${version}`);
  if (majorOf(version) < majorOf(VERSION)) refuse("older", `written under an older version: ${version}`);
};

const partsInOrder = ({ kind, parts }: Envelope): boolean => {
  const names = parts.map((one) => one.name);
  if (kind === "files") return names.every((one) => one === "file");
  return names[0] === "first" && names[1] === "rest" && names.slice(2).every((one) => one === "picture");
};

const holdsManifest = (manifest: Envelope, { id, kind }: { id: string; kind: EnvelopeKind }): void => {
  const amiss = check("envelope", manifest);
  if (amiss.length > 0) refuse("damaged", `its manifest: ${amiss[0]}`);
  if (manifest.id !== id) refuse("damaged", "it is not the document asked for");
  if (manifest.kind !== kind) refuse("damaged", "it is not the kind asked for");
  if (manifest.from !== undefined && manifest.from >= manifest.version) refuse("damaged", "it starts from a later one");
  if (manifest.parts.some((one) => one.compressed && one.name !== "first" && one.name !== "rest")) {
    refuse("damaged", "a picture or a file says it is compressed");
  }
  if (!partsInOrder(manifest)) refuse("damaged", "its parts are out of their order");
};

const verified = async (key: Uint8Array, signature: Uint8Array, ...signed: Uint8Array[]): Promise<boolean> => {
  const held = await crypto.subtle.importKey("raw", key, "Ed25519", false, ["verify"]);
  return crypto.subtle.verify("Ed25519", held, signature, joined(...signed));
};

const secondsOf = (moment: string): Uint8Array => bigEndian(Date.parse(moment) / 1000);

const holdsSignature = async (signature: Signature, manifestBytes: Uint8Array, index: Uint8Array): Promise<void> => {
  const amiss = check("signature", signature);
  if (amiss.length > 0) refuse("unsigned", `its signature: ${amiss[0]}`);
  const root = fromBase64Url(signature.root);
  const machine = fromBase64Url(signature.machine);
  const certified = await verified(
    root,
    fromBase64Url(signature.certificate),
    words("tisty-share.certificate.v1\0"),
    root,
    machine,
    secondsOf(signature.since),
  );
  if (!certified) refuse("unsigned", "its root does not answer for its machine");
  const about = words("envelope");
  const signed = await verified(
    machine,
    fromBase64Url(signature.signed),
    words("tisty-share.signed.v1\0"),
    root,
    machine,
    bigEndian(about.length),
    about,
    await sha256(manifestBytes),
    index,
  );
  if (!signed) refuse("unsigned", "its machine did not sign it");
};

const readBytes = async (bytes: Uint8Array, asked: Asked): Promise<ReadEnvelope> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = MARK.length;
  if (!sameBytes(bytes.subarray(0, at), MARK)) refuse("damaged", "it does not carry the mark");
  const piece = (size: number): Uint8Array => {
    if (at + size > bytes.length) refuse("damaged", "it is shorter than it says");
    at += size;
    return bytes.subarray(at - size, at);
  };
  const sized = (atMost: number, what: string): Uint8Array => {
    const size = view.getUint32(at);
    at += LENGTH_BYTES;
    if (size > atMost) refuse("damaged", `its ${what} is past its size`);
    return piece(size);
  };

  const manifestBytes = sized(MANIFEST_BYTES_AT_MOST, "manifest");
  const manifest = jsonIn<Envelope>(manifestBytes);
  weighVersion(manifest?.contract);
  holdsManifest(manifest, asked);
  const signature = jsonIn<Signature>(sized(SIGNATURE_BYTES_AT_MOST, "signature"));
  const index = piece(HASH_BYTES * manifest.parts.length);
  await holdsSignature(signature, manifestBytes, index);

  const parts: Uint8Array[] = [];
  for (const [number, part] of manifest.parts.entries()) {
    const travelled = piece(part.sealed_size);
    const said = index.subarray(HASH_BYTES * number, HASH_BYTES * (number + 1));
    if (!sameBytes(await sha256(travelled), said)) refuse("damaged", "a part is not what it signed");
    parts.push(travelled);
  }
  if (at !== bytes.length) refuse("damaged", "something follows its parts");
  return { manifest, manifestBytes, signature, index, parts };
};

// Anything else that breaks here comes from what arrived, so it is the envelope that is damaged.
export const asRefusal = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EnvelopeRefused) throw error;
    return refuse("damaged", String(error));
  }
};

// All the server can check, with nothing open (decisions 34 and 135). The page checks it again.
export const readEnvelope = (bytes: Uint8Array, asked: Asked): Promise<ReadEnvelope> =>
  asRefusal(() => readBytes(bytes, asked));

export const revocationHolds = (said: {
  root: string;
  machine: string;
  at: string;
  signed: string;
}): Promise<boolean> => {
  const root = fromBase64Url(said.root);
  return verified(
    root,
    fromBase64Url(said.signed),
    words("tisty-share.revocation.v1\0"),
    root,
    fromBase64Url(said.machine),
    secondsOf(said.at),
  );
};

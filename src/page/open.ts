import { check, checkHtml, type Document, type Picture, picturesIn, referencesIn } from "@tisty/contracts";
import { fromBase64Url, joined, sameBytes, sha256, words } from "../core/bytes";
import { type Asked, asRefusal, jsonIn, type ReadEnvelope, readEnvelope, refuse } from "../rules/envelope";

export interface OpenEnvelope extends ReadEnvelope {
  opened: Uint8Array[];
}

// This reader's own limit: a manifest only says how much will come, and six pages at their tops fit well under it.
const OPENS_AT_MOST = 32 * 1024 * 1024;
const NONCE_BYTES = 12;
const NONCE_NUMBER_AT = 8;

const inflated = async (bytes: Uint8Array, size: number): Promise<Uint8Array> => {
  if (size > OPENS_AT_MOST) refuse("damaged", "it says more than this reader holds");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  // Nothing set aside by what the manifest says, and stopped as soon as it passes: a bomb costs only what it gave so far.
  const pieces: Uint8Array[] = [];
  let held = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held += value.length;
    if (held > size) {
      await reader.cancel();
      refuse("damaged", "a part gives more than it says");
    }
    pieces.push(value);
  }
  if (held !== size) refuse("damaged", "a part gives less than it says");
  return joined(...pieces);
};

const envelopeKey = async ({ head, commitment }: ReadEnvelope["manifest"], linkKey: Uint8Array): Promise<CryptoKey> => {
  const salt = fromBase64Url(head as string);
  const signing = await crypto.subtle.importKey("raw", linkKey, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const committed = await crypto.subtle.verify(
    "HMAC",
    signing,
    fromBase64Url(commitment as string),
    joined(words("tisty-envelope-commit"), salt),
  );
  if (!committed) refuse("key", "this link does not open it");
  const base = await crypto.subtle.importKey("raw", linkKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: words("tisty-envelope-key") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
};

const nonceOf = (number: number): Uint8Array => {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setUint32(NONCE_NUMBER_AT, number);
  return nonce;
};

const opening = async (bytes: Uint8Array, asked: Asked, linkKey?: Uint8Array): Promise<OpenEnvelope> => {
  const read = await readEnvelope(bytes, asked);
  const { manifest, manifestBytes, parts } = read;
  if (linkKey && !manifest.sealed) refuse("damaged", "a key answers only for what is sealed");
  if (manifest.sealed && !linkKey) refuse("key", "it is sealed, and this link brings no key");
  const key = manifest.sealed ? await envelopeKey(manifest, linkKey as Uint8Array) : null;

  const opened: Uint8Array[] = [];
  for (const [number, part] of manifest.parts.entries()) {
    const travelled = parts[number] as Uint8Array;
    const held = key
      ? new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonceOf(number), additionalData: manifestBytes },
            key,
            travelled,
          ),
        )
      : travelled;
    if (!part.compressed && held.length !== part.open_size) refuse("damaged", "a part is not the size it says");
    opened.push(part.compressed ? await inflated(held, part.open_size) : held);
  }
  return { ...read, opened };
};

export const openEnvelope = (bytes: Uint8Array, asked: Asked, linkKey?: Uint8Array): Promise<OpenEnvelope> =>
  asRefusal(() => opening(bytes, asked, linkKey));

const atsOf = (list: { at: number }[] | undefined): number[] => (list ?? []).map((one) => one.at);

const holdsHtml = (held: Document, pictures: Picture[], html: string): void => {
  const amiss = checkHtml(html);
  if (amiss.length > 0) refuse("damaged", `its HTML: ${amiss[0]}`);
  const there: Record<string, number[]> = {
    page: atsOf(held.pages),
    picture: atsOf(pictures),
    file: atsOf(held.files),
    cited: (held.cited ?? []).map((_, at) => at),
  };
  for (const { kind, at } of referencesIn(html)) {
    if (!there[kind]?.includes(at)) refuse("damaged", `tisty:${kind}/${at} is not there`);
  }
  for (const { at, width, height } of picturesIn(html)) {
    const picture = pictures[at];
    if (width !== String(picture?.width) || height !== String(picture?.height)) {
      refuse("damaged", "a picture is drawn at another size than its own");
    }
  }
};

const documentFrom = ({ manifest, opened }: OpenEnvelope): Document => {
  const first = jsonIn<Record<string, unknown>>(opened[0] as Uint8Array);
  const rest = jsonIn<Record<string, unknown>>(opened[1] as Uint8Array);
  if ("body" in first || "pages" in first) refuse("damaged", "the first part holds more than it should");
  if (Object.keys(rest).some((one) => one !== "body" && one !== "pages")) {
    refuse("damaged", "the rest holds more than it should");
  }
  const held = { ...first, ...rest } as unknown as Document;
  const amiss = check("document", held);
  if (amiss.length > 0) refuse("damaged", `its document: ${amiss[0]}`);
  if (held.id !== manifest.id) refuse("damaged", "the document inside is another");

  const pictures = held.pictures ?? [];
  if (pictures.length !== opened.length - 2) refuse("damaged", "it holds another number of pictures");
  pictures.forEach((one, at) => {
    if (one.at !== at || one.size !== opened[at + 2]?.length) refuse("damaged", "a picture is not what it says");
  });
  const pages = held.pages ?? [];
  if (pages.some((one) => one.page_of !== held.id)) refuse("damaged", "a page is of another document");
  if (pages.some((one, at) => at > 0 && (pages[at - 1] as { at: number }).at >= one.at)) {
    refuse("damaged", "its pages are out of their order");
  }
  if (new Set(pages.map((one) => one.id)).size !== pages.length) refuse("damaged", "two pages share an id");
  if ((held.files ?? []).length > 0 !== (held.files_hash != null)) {
    refuse("damaged", "files and the hash that answers for them go together");
  }
  for (const html of [held.html, ...pages.map((one) => one.html)]) holdsHtml(held, pictures, html);
  return held;
};

// Everything only a reader can check: a writer's word counts for nothing, so its words are not shown if this fails.
export const documentIn = (open: OpenEnvelope): Promise<Document> => asRefusal(async () => documentFrom(open));

export const openFiles = (
  held: Document,
  bytes: Uint8Array,
  asked: Asked,
  linkKey?: Uint8Array,
): Promise<OpenEnvelope> =>
  asRefusal(async () => {
    const files = await opening(bytes, asked, linkKey);
    const hash = await sha256(files.manifestBytes, files.index);
    if (!held.files_hash || !sameBytes(hash, fromBase64Url(held.files_hash))) {
      refuse("damaged", "it is not the envelope its document answers for");
    }
    const said = held.files ?? [];
    if (said.length !== files.opened.length) refuse("damaged", "it holds another number of files");
    said.forEach((one, at) => {
      if (one.at !== at || (one.size !== undefined && one.size !== files.opened[at]?.length)) {
        refuse("damaged", "a file is not what it says");
      }
    });
    return files;
  });

const PNG_MARK = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngHolds = (bytes: Uint8Array, view: DataView, { width, height }: Picture): boolean => {
  if (!PNG_MARK.every((byte, at) => bytes[at] === byte)) return false;
  let said: number[] | null = null;
  for (let at = PNG_MARK.length; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at === PNG_MARK.length && name === "IHDR" && length >= 8 && at + 16 <= bytes.length) {
      said = [view.getUint32(at + 8), view.getUint32(at + 12)];
    }
    at += 12 + length;
    if (name === "IEND") return at === bytes.length && said?.[0] === width && said?.[1] === height;
  }
  return false;
};

const jpegSizeMark = (mark: number): boolean => mark >= 0xc0 && mark <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mark);

const jpegHolds = (bytes: Uint8Array, view: DataView, { width, height }: Picture): boolean => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
  let said: number[] | null = null;
  for (let at = 2; at + 1 < bytes.length; ) {
    const mark = bytes[at + 1] as number;
    if (bytes[at] !== 0xff || mark === 0xff) at += 1;
    else if (mark === 0xd9) return at + 2 === bytes.length && said?.[0] === width && said?.[1] === height;
    else if (mark === 0 || mark === 1 || (mark >= 0xd0 && mark <= 0xd8)) at += 2;
    else {
      if (at + 4 > bytes.length) return false;
      if (jpegSizeMark(mark) && at + 9 <= bytes.length) said = [view.getUint16(at + 7), view.getUint16(at + 5)];
      at += 2 + view.getUint16(at + 2);
    }
  }
  return false;
};

// What the page looks at before it draws one. One that fails shows its alt, and the words still read.
export const pictureHolds = (bytes: Uint8Array, picture: Picture): boolean => {
  if (bytes.length !== picture.size) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return picture.kind === "image/png" ? pngHolds(bytes, view, picture) : jpegHolds(bytes, view, picture);
};

const encoder = new TextEncoder();

export const words = (said: string): Uint8Array => encoder.encode(said);

export const fromBase64Url = (said: string): Uint8Array => {
  const plain = atob(said.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(plain, (one) => one.charCodeAt(0));
};

export const joined = (...pieces: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(pieces.reduce((sum, one) => sum + one.length, 0));
  let at = 0;
  for (const one of pieces) {
    out.set(one, at);
    at += one.length;
  }
  return out;
};

export const sameBytes = (one: Uint8Array, other: Uint8Array): boolean =>
  one.length === other.length && one.every((byte, at) => byte === other[at]);

export const sha256 = async (...pieces: Uint8Array[]): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", joined(...pieces)));

export const bigEndian = (number: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(number));
  return out;
};

import { CONTRACTS, check, type EnvelopePart, referencesIn, VERSION } from "@tisty/contracts";
import VECTORS from "@tisty/contracts/vectors.json";
import { describe, expect, it } from "vitest";
import { bigEndian, fromBase64Url, joined, sha256, words } from "../src/core/bytes";
import { toBase64Url } from "../src/core/start";
import { documentIn, openEnvelope, openFiles, pictureHolds } from "../src/page/open";
import { fingerprintOf, verdictOf } from "../src/page/verdict";
import { EnvelopeRefused, readEnvelope, revocationHolds } from "../src/rules/envelope";
import WRITTEN from "./fixtures/written-by-tisty.json";

// biome-ignore lint/suspicious/noExplicitAny: these are the contract's own samples, in the shape it writes them.
const SAMPLES = VECTORS as any;

const hex = (said: string): Uint8Array => Uint8Array.from(said.match(/../g) ?? [], (one) => Number.parseInt(one, 16));
const hexOf = (bytes: Uint8Array): string => [...bytes].map((one) => one.toString(16).padStart(2, "0")).join("");

const LINK_KEY = fromBase64Url(SAMPLES.link_key);
const MAIN = { id: "k7Qm2xPa", kind: "main" } as const;
const FILES = { id: "k7Qm2xPa", kind: "files" } as const;
const PUBLIC = { id: "wordsOnly", kind: "main" } as const;
const HOSTILE = { id: "hostile", kind: "main" } as const;

const reading = async (bytes: Uint8Array, asked: typeof MAIN | typeof PUBLIC | typeof HOSTILE, key?: Uint8Array) => {
  const main = await openEnvelope(bytes, asked, key);
  return { main, held: await documentIn(main) };
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EnvelopeRefused);
  return (error as EnvelopeRefused).refusal;
};

const squeezed = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
  );

const lengthOf = (size: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, size);
  return out;
};

const signing = async () => (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const raw = async (key: CryptoKey) => new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
const signedBy = async (key: CryptoKey, ...pieces: Uint8Array[]) =>
  new Uint8Array(await crypto.subtle.sign("Ed25519", key, joined(...pieces)));

type TravellingPart = EnvelopePart & { bytes: Uint8Array };

interface Building {
  saysOpen?: (open: number) => number;
  order?: (parts: TravellingPart[]) => TravellingPart[];
  manifestPadding?: number;
  signaturePadding?: number;
  rest?: Uint8Array;
}

const BUILT = { id: "builtHere", kind: "main" } as const;

// A public envelope signed here, so each rule is tried on what only that rule refuses: the signature still holds.
const built = async ({ saysOpen = (open) => open, order = (parts) => parts, ...more }: Building = {}) => {
  const first = words(JSON.stringify({ id: BUILT.id, html: "<p>x</p>" }));
  const rest = more.rest ?? words(JSON.stringify({ body: "x" }));
  const squeezedFirst = await squeezed(first);
  const squeezedRest = await squeezed(rest);
  const parts: TravellingPart[] = order([
    {
      name: "first",
      compressed: true,
      sealed_size: squeezedFirst.length,
      open_size: saysOpen(first.length),
      bytes: squeezedFirst,
    },
    {
      name: "rest",
      compressed: true,
      sealed_size: squeezedRest.length,
      open_size: saysOpen(rest.length),
      bytes: squeezedRest,
    },
  ]);
  const travelling = parts.map((one) => one.bytes);
  const manifest = {
    contract: VERSION,
    kind: "main",
    id: BUILT.id,
    version: 1,
    sealed: false,
    parts: parts.map(({ bytes: _, ...part }) => part),
  };
  const manifestBytes = words(JSON.stringify(manifest) + " ".repeat(more.manifestPadding ?? 0));
  const index = joined(...(await Promise.all(travelling.map((one) => sha256(one)))));

  const rootKeys = await signing();
  const machineKeys = await signing();
  const root = await raw(rootKeys.publicKey);
  const machine = await raw(machineKeys.publicKey);
  const since = "2026-01-01T00:00:00Z";
  const about = words("envelope");
  const signature = {
    root: toBase64Url(root),
    machine: toBase64Url(machine),
    since,
    certificate: toBase64Url(
      await signedBy(
        rootKeys.privateKey,
        words("tisty-share.certificate.v1\0"),
        root,
        machine,
        bigEndian(Date.parse(since) / 1000),
      ),
    ),
    signed: toBase64Url(
      await signedBy(
        machineKeys.privateKey,
        words("tisty-share.signed.v1\0"),
        root,
        machine,
        bigEndian(about.length),
        about,
        await sha256(manifestBytes),
        index,
      ),
    ),
  };
  const signatureBytes = words(JSON.stringify(signature) + " ".repeat(more.signaturePadding ?? 0));
  return joined(
    words("TENV"),
    lengthOf(manifestBytes.length),
    manifestBytes,
    lengthOf(signatureBytes.length),
    signatureBytes,
    index,
    ...travelling,
  );
};

describe("what only one rule refuses, on an envelope whose signature holds", () => {
  it("opens as it is, so what follows is about each rule", async () => {
    const { held } = await reading(await built(), BUILT as never);
    expect(held.html).toBe("<p>x</p>");
  });

  it("another mark, which no signature covers", async () => {
    const bytes = await built();
    bytes[0] = (bytes[0] as number) ^ 1;
    expect(await refusal(readEnvelope(bytes, BUILT))).toBe("damaged");
  });

  it("a manifest past its size", async () => {
    expect(await refusal(readEnvelope(await built({ manifestPadding: 16384 }), BUILT))).toBe("damaged");
  });

  it("a signature past its size", async () => {
    expect(await refusal(readEnvelope(await built({ signaturePadding: 2048 }), BUILT))).toBe("damaged");
  });

  it("one that ends inside its index, which is not a matter of who signed it", async () => {
    const whole = await built();
    const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
    const signatureLengthAt = 8 + view.getUint32(4);
    const indexAt = signatureLengthAt + 4 + view.getUint32(signatureLengthAt);
    expect(await refusal(readEnvelope(whole.slice(0, indexAt + 10), BUILT))).toBe("damaged");
  });

  it("parts out of their order, before anything is open", async () => {
    const bytes = await built({ order: (parts) => [...parts].reverse() });
    expect(await refusal(readEnvelope(bytes, BUILT))).toBe("damaged");
  });

  it("a part that gives less than it says", async () => {
    const bytes = await built({ saysOpen: (open) => open + 1 });
    await readEnvelope(bytes, BUILT);
    expect(await refusal(openEnvelope(bytes, BUILT))).toBe("damaged");
  });

  it("a part that gives more than it says", async () => {
    const bytes = await built({ saysOpen: (open) => open - 1 });
    expect(await refusal(openEnvelope(bytes, BUILT))).toBe("damaged");
  });

  it("a part past what this reader holds, even when it says so honestly", async () => {
    const zeros = new Uint8Array(33 * 1024 * 1024);
    const bytes = await built({ rest: zeros });
    await readEnvelope(bytes, BUILT);
    expect(await refusal(openEnvelope(bytes, BUILT))).toBe("damaged");
  });
});

describe("the contract in use", () => {
  it("is the version Folio fixed, and these samples are written under it", async () => {
    expect(VERSION).toBe("1.0.0");
    const { manifest } = await readEnvelope(hex(SAMPLES.main.envelope), MAIN);
    expect(manifest.contract).toBe(VERSION);
  });

  it("gives the sizes this reader holds to", () => {
    const { values } = CONTRACTS.envelope as { values: { sizes_at_most: object } };
    expect(values.sizes_at_most).toEqual({ manifest_bytes: 16384, signature_bytes: 2048 });
  });
});

describe("what the server checks, with nothing open", () => {
  it("reads a sealed envelope without its key", async () => {
    const read = await readEnvelope(hex(SAMPLES.main.envelope), MAIN);
    expect(read.manifest.sealed).toBe(true);
    expect(read.parts.length).toBe(read.manifest.parts.length);
  });

  it("refuses another document, and another kind", async () => {
    expect(await refusal(readEnvelope(hex(SAMPLES.public.envelope), MAIN))).toBe("damaged");
    expect(await refusal(readEnvelope(hex(SAMPLES.files.envelope), MAIN))).toBe("damaged");
  });

  it("refuses a change in any byte that travels", async () => {
    for (const at of [-1, 40]) {
      const bytes = hex(SAMPLES.main.envelope);
      const place = at < 0 ? bytes.length + at : at;
      bytes[place] = (bytes[place] as number) ^ 1;
      await refusal(readEnvelope(bytes, MAIN));
    }
  });

  it("refuses one cut short", async () => {
    expect(await refusal(readEnvelope(hex(SAMPLES.main.envelope).slice(0, -1), MAIN))).toBe("damaged");
  });

  it("refuses something after its parts", async () => {
    const whole = hex(SAMPLES.public.envelope);
    const longer = new Uint8Array(whole.length + 1);
    longer.set(whole);
    expect(await refusal(readEnvelope(longer, PUBLIC))).toBe("damaged");
  });

  it("refuses what is not an envelope at all", async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(100)]) {
      expect(await refusal(readEnvelope(bytes, MAIN))).toBe("damaged");
    }
  });

  it("tells a signature that does not hold from a damaged envelope", async () => {
    const bytes = hex(SAMPLES.public.envelope);
    const view = new DataView(bytes.buffer);
    const signatureAt = 8 + view.getUint32(4);
    const text = new TextDecoder().decode(
      bytes.subarray(signatureAt + 4, signatureAt + 4 + view.getUint32(signatureAt)),
    );
    const where = text.indexOf('"signed":"') + '"signed":"'.length;
    const place = signatureAt + 4 + where;
    bytes[place] = bytes[place] === 65 ? 66 : 65;
    expect(await refusal(readEnvelope(bytes, PUBLIC))).toBe("unsigned");
  });
});

describe("the samples a reader refuses", () => {
  it.each(SAMPLES.refused as { says: string; envelope: string }[])("$says", async ({ envelope }) => {
    await refusal(reading(hex(envelope), HOSTILE));
  });

  it.each(SAMPLES.files_refused as { says: string; main: { id: string }; files: string }[])(
    "$says",
    async ({ main, files }) => {
      const { held } = await reading(hex(SAMPLES.main.envelope), { ...MAIN, id: main.id } as typeof MAIN, LINK_KEY);
      await refusal(openFiles(held, hex(files), { id: main.id, kind: "files" }, LINK_KEY));
    },
  );

  it.each(SAMPLES.files_lying as { says: string; document: never; files: string }[])(
    "$says",
    async ({ document, files }) => {
      await refusal(openFiles(document, hex(files), { id: "hostile", kind: "files" }));
    },
  );

  it("something past the end of a part, where the runtime can see it", async () => {
    const seesIt = await new Response(
      new Blob([Uint8Array.of(3, 0, 1)]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
    )
      .arrayBuffer()
      .then(
        () => false,
        () => true,
      );
    if (seesIt) await refusal(reading(hex(SAMPLES.past_its_end), HOSTILE));
  });

  it("tells a newer major version from a damaged one, whatever it holds", async () => {
    expect(await refusal(reading(hex(SAMPLES.a_newer_major), HOSTILE))).toBe("newer");
  });
});

describe("the samples a reader opens", () => {
  it.each(SAMPLES.opening as { says: string; envelope: string }[])("$says", async ({ envelope }) => {
    await reading(hex(envelope), HOSTILE);
  });

  it("a main envelope gives its document, its pages and its pictures, with no other request", async () => {
    const { main, held } = await reading(hex(SAMPLES.main.envelope), MAIN, LINK_KEY);
    expect(held).toEqual(SAMPLES.main.document);
    expect(main.opened.slice(2).map(hexOf)).toEqual(SAMPLES.main.pictures);
    for (const [at, one] of (held.pictures ?? []).entries()) {
      expect(pictureHolds(main.opened[at + 2] as Uint8Array, one)).toBe(true);
    }
  });

  it("a files envelope gives its files, and the main envelope answers for it", async () => {
    const files = await openFiles(SAMPLES.main.document, hex(SAMPLES.files.envelope), FILES, LINK_KEY);
    expect(files.opened.map(hexOf)).toEqual(SAMPLES.files.files);
  });

  it("what Tisty sealed in Rust", async () => {
    const key = fromBase64Url(WRITTEN.link_key);
    const { held } = await reading(hex(WRITTEN.main), { id: "writtenByTisty", kind: "main" } as never, key);
    await openFiles(held, hex(WRITTEN.files), { id: "writtenByTisty", kind: "files" }, key);
  });

  it("a public envelope, without a key, and words alone in one envelope", async () => {
    const { main, held } = await reading(hex(SAMPLES.public.envelope), PUBLIC);
    expect(held).toEqual(SAMPLES.public.document);
    expect(main.manifest.parts.length).toBe(2);
  });

  it("not with another key", async () => {
    expect(await refusal(openEnvelope(hex(SAMPLES.main.envelope), MAIN, new Uint8Array(32)))).toBe("key");
  });

  it("not without a key", async () => {
    expect(await refusal(openEnvelope(hex(SAMPLES.main.envelope), MAIN))).toBe("key");
  });

  it("not what is unsealed, under a link with a key", async () => {
    expect(await refusal(openEnvelope(hex(SAMPLES.public.envelope), PUBLIC, LINK_KEY))).toBe("damaged");
  });
});

describe("the pictures", () => {
  it.each(SAMPLES.pictures.hold as { kind: string; bytes: string }[])("a real $kind holds", (one) => {
    expect(pictureHolds(hex(one.bytes), one as never)).toBe(true);
  });

  it.each(SAMPLES.pictures.fail as { says: string; bytes: string }[])("not $says", (one) => {
    expect(pictureHolds(hex(one.bytes), one as never)).toBe(false);
  });
});

describe("the signature", () => {
  it.each(SAMPLES.verdicts as { says: string; served: object; verdict: string }[])(
    "is $verdict when $says",
    async ({ served, verdict }) => {
      expect(check("served", served)).toEqual([]);
      expect(await verdictOf(SAMPLES.signed_by, served)).toBe(verdict);
    },
  );

  it("is shown as the fingerprint the contract's words make of a root", async () => {
    expect(await fingerprintOf(SAMPLES.identity.root)).toBe(SAMPLES.identity.fingerprint);
  });

  it("is revoked only by its root", async () => {
    expect(check("revocation", SAMPLES.revocation)).toEqual([]);
    expect(await revocationHolds(SAMPLES.revocation)).toBe(true);
    expect(await revocationHolds({ ...SAMPLES.revocation, at: "2020-01-01T00:00:00Z" })).toBe(false);
  });
});

describe("the references", () => {
  it("are read as a browser reads them, and only where they lead", () => {
    expect(referencesIn(SAMPLES.references.html)).toEqual(SAMPLES.references.said);
  });
});

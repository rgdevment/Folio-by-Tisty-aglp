import type { Envelope, Owner } from "@tisty/contracts";
import { EnvelopeRefused, isBelowVersion, type ReadEnvelope, readEnvelope } from "../rules/envelope";
import { type Bytes, sha256 } from "./bytes";
import { dayOf, type Limits } from "./limits";
import { netDigest } from "./net";
import type { ReadTools } from "./read";
import { askForProof, type Refused, tooFast } from "./refused";
import { hourEnds, hourOf, proofIsFresh, startHolds, toBase64Url, tokenHash } from "./start";
import type { Created, Held, Uploaded } from "./store";
import { uploadAllowedAt } from "./versions";

export interface FirstUpload {
  start: string;
  proof: string;
  adminToken: string;
  ttlDays: number;
  anchor?: string;
}

export interface Uploading {
  id: string;
  ip: string;
  now: number;
  bytes: Bytes;
  first?: FirstUpload;
}

export type UploadAnswer = { stored: true; version: number } | Refused;

const ownerMarkOf = ({ machine, name_tag: nameTag }: Owner): string => `${machine}.${nameTag}`;

const withinTops = ({ parts }: Envelope, limits: Limits): boolean => {
  const pictures = parts.filter((one) => one.name === "picture");
  const biggest = (name: string): number =>
    Math.max(0, ...parts.filter((one) => one.name === name).flatMap((one) => [one.sealed_size, one.open_size]));
  return (
    pictures.length <= limits.picturesAtMost &&
    biggest("picture") <= limits.pictureBytesAtMost &&
    pictures.reduce((sum, one) => sum + one.sealed_size, 0) <= limits.picturesBytesAtMost &&
    biggest("first") <= limits.firstBytesAtMost &&
    biggest("rest") <= limits.restBytesAtMost
  );
};

const readOrRefuse = async (id: string, bytes: Bytes): Promise<ReadEnvelope | Refused> => {
  try {
    const read = await readEnvelope(bytes, { id, kind: "main" });
    return read.manifest.sealed ? read : { refused: "envelope", why: "damaged" };
  } catch (error) {
    if (error instanceof EnvelopeRefused) return { refused: "envelope", why: error.refusal };
    throw error;
  }
};

const REFUSAL_OF_CREATED: Partial<Record<Created, Refused["refused"]>> = {
  taken: "not_yours",
  shares_full: "shares_full",
  no_anchor: "bad_upload",
  bad_ttl: "bad_upload",
};

const share = async (
  { id, now, first }: Uploading,
  { manifest }: ReadEnvelope,
  net: string,
  { store, limits, secret }: ReadTools,
): Promise<Refused | null> => {
  if (!first?.adminToken || !(await startHolds(secret, id, first.start, now))) return { refused: "bad_upload" };
  const proved = await proofIsFresh(secret, id, first.proof, limits.proofBits, now);
  if (!proved) return askForProof(secret, id, limits.proofBits, now);
  const owner = manifest.owner as Owner;
  const created = await store.create(
    {
      id,
      owner: owner.root,
      adminHash: await tokenHash(first.adminToken),
      ttlDays: first.ttlDays,
      net,
      ownerMark: ownerMarkOf(owner),
      ...(owner.permit === undefined ? {} : { permit: owner.permit }),
      ...(first.anchor === undefined ? {} : { anchor: first.anchor }),
    },
    dayOf(now),
  );
  if (created === "quota") return { refused: "quota", until: hourEnds(now) };
  const refused = REFUSAL_OF_CREATED[created];
  return refused ? ({ refused } as Refused) : null;
};

const mayUpload = ({ manifest, signature }: ReadEnvelope, held: Held): boolean => {
  const owner = manifest.owner as Owner;
  if (owner.root !== held.owner || (owner.permit ?? null) !== held.permit) return false;
  return signature.root === held.owner || ownerMarkOf(owner) === held.ownerMark;
};

const answerOf = (uploaded: Uploaded, version: number, now: number): UploadAnswer => {
  switch (uploaded) {
    case "stored":
    case "same":
      return { stored: true, version };
    case "behind":
      return { refused: "behind" };
    case "missing":
    case "blocked":
    case "paused":
      return { refused: uploaded };
    case "quota":
    case "list_full":
      return { refused: "quota", until: hourEnds(now) };
  }
};

export const uploadDoc = async (uploading: Uploading, tools: ReadTools): Promise<UploadAnswer> => {
  const { id, ip, now, bytes, first } = uploading;
  const { store, limiter, limits, dayKey } = tools;
  const today = dayOf(now);
  const net = await netDigest(await dayKey(today), ip);
  if (!(await limiter.allows(net))) return tooFast(now);
  const stage = await store.stage();
  if (stage === "no_uploads" || stage === "blocked") return { refused: "uploads_off" };
  if (bytes.length > limits.envelopeBytesAtMost) return { refused: "too_big" };

  const read = await readOrRefuse(id, bytes);
  if ("refused" in read) return read;
  const { manifest, signature } = read;
  if (!withinTops(manifest, limits)) return { refused: "too_big" };
  const floor = limits.oldestContractTaken;
  if (floor !== null && isBelowVersion(manifest.contract, floor)) return { refused: "outdated" };

  const hash = toBase64Url(await sha256(bytes));
  let held = await store.held(id);
  if (held?.latest === manifest.version && held.versions.at(-1)?.hash === hash) {
    return { stored: true, version: manifest.version };
  }
  if (!held) {
    if (!first) return { refused: "missing" };
    const refused = await share(uploading, read, net, tools);
    if (refused) return refused;
    held = await store.held(id);
    if (!held) return { refused: "missing" };
  }
  if (!mayUpload(read, held)) return { refused: "not_yours" };

  const allowedAt = uploadAllowedAt(held.versions, signature.root, now, limits);
  if (allowedAt > now) return { refused: "slow", until: allowedAt };
  if (!(await store.takeHourly(net, "upload", hourOf(now), limits.uploadsAnHour))) {
    return { refused: "quota", until: hourEnds(now) };
  }

  const owner = manifest.owner as Owner;
  const uploaded = await store.upload(
    {
      id,
      n: manifest.version,
      hash,
      body: bytes,
      net,
      at: now,
      signer: signature.root,
      contract: manifest.contract,
      byOwner: signature.root === held.owner,
      permit: held.permit,
      ownerMark: ownerMarkOf(owner),
    },
    today,
  );
  return answerOf(uploaded, manifest.version, now);
};

export const setPermitHolds = (said: unknown): said is { permit: string | null } => {
  if (typeof said !== "object" || said === null || !("permit" in said)) return false;
  const { permit } = said as { permit: unknown };
  return permit === null || (typeof permit === "string" && /^[A-Za-z0-9_-]{43}$/.test(permit));
};

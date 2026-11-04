export interface Version {
  n: number;
  hash: string;
  bytes: number;
  at: number;
}

export interface NewDoc {
  id: string;
  owner: string;
  anchor?: string;
  editHash: string;
  adminHash: string;
  ttlDays: number;
  net: string;
}

export interface Upload {
  id: string;
  n: number;
  hash: string;
  body: ArrayBuffer | Uint8Array | string;
  net: string;
  at: number;
}

export interface Reading {
  owner: string;
  reader: string;
  doc: string;
  hour: number;
  proved: boolean;
}

export interface Report {
  doc: string;
  net: string;
  category: string;
  detail?: string;
  sealedLink?: string;
}

// What a read needs of a document, in one row.
export interface Shown {
  owner: string;
  password: string | null;
  guessDay: number | null;
  guessCount: number;
  version: Version | null;
  diesOn: number;
  alive: boolean;
  pausedAt: number | null;
  blockedAt: number | null;
}

export type Created = "created" | "same" | "taken" | "shares_full" | "no_anchor" | "quota" | "bad_ttl";
export type Uploaded = "stored" | "same" | "behind" | "missing" | "blocked" | "quota";
export type Admitted = "here" | "new" | "over" | "full";
export type Stage = "open" | "warned" | "no_uploads" | "blocked";

export interface Swept {
  summed: number;
  forgotten: number;
  failed: number;
}

// What the rules need of wherever Folio runs, so the core never knows it is Cloudflare (decisions 16 and 108).
export interface Store {
  create(doc: NewDoc, today: number): Promise<Created>;
  upload(upload: Upload, today: number): Promise<Uploaded>;
  admit(reading: Reading, today: number): Promise<Admitted>;
  note(reading: Reading, today: number): Promise<void>;
  shown(id: string, today: number): Promise<Shown | null>;
  envelope(id: string, version: Version): Promise<ReadableStream | null>;
  wrongGuesses(id: string, net: string, slot: number): Promise<number>;
  noteWrongGuess(id: string, net: string, slot: number, today: number): Promise<void>;
  dayKey(today: number): Promise<string>;
  report(report: Report, today: number): Promise<{ blocked: boolean }>;
  appealAccepted(id: string, today: number): Promise<void>;
  pause(id: string, today: number): Promise<void>;
  resume(id: string, today: number): Promise<void>;
  sweep(today: number): Promise<Swept>;
  forgetOrphans(now: number): Promise<number>;
  stage(): Promise<Stage>;
  setStage(stage: Stage): Promise<void>;
  liftCut(today: number): Promise<void>;
}

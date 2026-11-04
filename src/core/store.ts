export interface Version {
  n: number;
  hash: string;
  bytes: number;
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

export type Created = "created" | "same" | "taken" | "shares_full" | "no_anchor" | "quota" | "bad_ttl";
export type Uploaded = "stored" | "same" | "behind" | "missing" | "blocked" | "quota";
export type Noted = "here" | "noted" | "over" | "full";

export interface Swept {
  summed: number;
  forgotten: number;
  failed: number;
}

// What the rules need of wherever Folio runs, so the core never knows it is Cloudflare (decisions 16 and 108).
export interface Store {
  create(doc: NewDoc, today: number): Promise<Created>;
  upload(upload: Upload, today: number): Promise<Uploaded>;
  noteReader(reading: Reading, today: number): Promise<Noted>;
  report(report: Report, today: number): Promise<{ blocked: boolean }>;
  appealAccepted(id: string, today: number): Promise<void>;
  pause(id: string, today: number): Promise<void>;
  resume(id: string, today: number): Promise<void>;
  sweep(today: number): Promise<Swept>;
  forgetOrphans(now: number): Promise<number>;
}

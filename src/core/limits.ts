export interface Limits {
  ttlChoices: number[];
  sharesAtMost: number;
  versionsKept: number;
  newReadersFree: number;
  rowsPerOwnerADay: number;
  netDocsADay: number;
  netBytesADay: number;
  reportsAnHour: number;
  reportDetailAtMost: number;
  sealedLinkAtMost: number;
  pausedDays: number;
  evidenceDays: number;
  reportsToBlock: number;
  reportOperatorsToBlock: number;
  sweptAtOnce: number;
  historyDays: number;
  hoursFromReaders: number;
  proofBits: number;
}

// Level 1 (decisions 36, 41, 42, 49, 93 bis, 97, 116, 128 and 136). They move to the signed file with the rules (decision 120).
export const LEVEL_ONE: Limits = {
  ttlChoices: [1, 3, 7, 15],
  sharesAtMost: 2,
  versionsKept: 5,
  newReadersFree: 250,
  rowsPerOwnerADay: 5000,
  netDocsADay: 50,
  netBytesADay: 200 * 1000 * 1000,
  reportsAnHour: 10,
  reportDetailAtMost: 2000,
  sealedLinkAtMost: 1024,
  pausedDays: 30,
  evidenceDays: 180,
  reportsToBlock: 3,
  reportOperatorsToBlock: 2,
  sweptAtOnce: 500,
  historyDays: 90,
  hoursFromReaders: 5,
  proofBits: 16,
};

// What anyone can report (decisions 38 and 42). Copyright is not here: its holder asks, and it comes down with no evidence.
export const GRAVE_REPORTS = ["csam", "phishing", "malware", "scam", "threat", "doxxing", "intimate"];

export const DAY_MS = 86_400_000;

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

export interface Limits {
  ttlChoices: number[];
  sharesAtMost: number;
  versionsKept: number;
  newReadersFree: number;
  rowsPerOwnerADay: number;
  netDocsADay: number;
  netBytesADay: number;
  pausedDays: number;
  evidenceDays: number;
  reportsToBlock: number;
  sweptAtOnce: number;
  guessSlotsADay: number;
  historyDays: number;
  hoursFromReaders: number;
}

// Level 1 (decisions 49, 93 bis, 97, 116, 128 and 136). They move to the signed file with the rules (decision 120).
export const LEVEL_ONE: Limits = {
  ttlChoices: [1, 3, 7, 15],
  sharesAtMost: 2,
  versionsKept: 5,
  newReadersFree: 250,
  rowsPerOwnerADay: 5000,
  netDocsADay: 50,
  netBytesADay: 200 * 1000 * 1000,
  pausedDays: 30,
  evidenceDays: 90,
  reportsToBlock: 3,
  sweptAtOnce: 500,
  guessSlotsADay: 96,
  historyDays: 90,
  hoursFromReaders: 5,
};

export const DAY_MS = 86_400_000;

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

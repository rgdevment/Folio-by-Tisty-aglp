-- Who reported something whose appeal was accepted, which stops counting until its evidence days pass (decision 41).
ALTER TABLE reports ADD COLUMN asn INTEGER;

CREATE TABLE false_reporters (
  net TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) WITHOUT ROWID;

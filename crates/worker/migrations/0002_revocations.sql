-- A root's word taking a machine's key back, kept for good so readers learn of it (decision 73).
CREATE TABLE revocations (
  share TEXT NOT NULL,
  root TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (share, root)
) STRICT;

-- What Tisty Share keeps in D1: what it knows of each document, never a word of it.
CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX docs_by_end ON docs (ends);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  until INTEGER NOT NULL
) STRICT;
CREATE INDEX counters_by_end ON counters (until);

CREATE TABLE holds (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL
) STRICT;
CREATE INDEX holds_by_end ON holds (until);

CREATE TABLE reports (
  id TEXT NOT NULL,
  until INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX reports_by_doc ON reports (id);
CREATE INDEX reports_by_end ON reports (until);

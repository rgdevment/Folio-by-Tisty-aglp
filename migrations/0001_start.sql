-- Every table finds by its key, since each index apart costs another row on every write (decision 128).
-- The readers of each day live in their own table, seen_<day>, which the store creates and drops: dropping costs no rows.

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  anchor TEXT,
  edit_hash TEXT NOT NULL,
  admin_hash TEXT NOT NULL,
  password TEXT,
  guess_day INTEGER,
  guess_count INTEGER NOT NULL DEFAULT 0,
  latest INTEGER NOT NULL DEFAULT 0,
  versions TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0,
  files_at INTEGER,
  ttl_days INTEGER NOT NULL,
  dies_on INTEGER NOT NULL,
  active_day INTEGER NOT NULL,
  paused_at INTEGER,
  blocked_at INTEGER,
  appealed_at INTEGER,
  read_total INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Written only when a document is created, since nothing else changes the owner.
CREATE INDEX docs_owner ON docs (owner, anchor);

CREATE TABLE net_day (
  day INTEGER NOT NULL,
  net TEXT NOT NULL,
  docs INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (day, net)
) WITHOUT ROWID;

CREATE TABLE guesses (
  slot INTEGER NOT NULL,
  net TEXT NOT NULL,
  doc TEXT NOT NULL,
  wrong INTEGER NOT NULL,
  PRIMARY KEY (slot, net, doc)
) WITHOUT ROWID;

CREATE TABLE reports (
  doc TEXT NOT NULL,
  net TEXT NOT NULL,
  at INTEGER NOT NULL,
  category TEXT NOT NULL,
  detail TEXT,
  sealed_link TEXT,
  cleared INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc, net)
) WITHOUT ROWID;

CREATE TABLE revocations (
  root TEXT NOT NULL,
  machine TEXT NOT NULL,
  at INTEGER NOT NULL,
  signed TEXT NOT NULL,
  PRIMARY KEY (root, machine)
) WITHOUT ROWID;

CREATE TABLE holds (
  held TEXT NOT NULL,
  holder TEXT NOT NULL,
  PRIMARY KEY (held, holder)
) WITHOUT ROWID;

-- A document that dies has to let go of what it holds, and holds change far less than they are read.
CREATE INDEX holds_holder ON holds (holder);

-- Only the exceptions: a key with no row is at level 1.
CREATE TABLE owners (
  root TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 1,
  blocked_at INTEGER
) WITHOUT ROWID;

CREATE TABLE blocked (
  net TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE openings (
  doc TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (doc, at)
) WITHOUT ROWID;

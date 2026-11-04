import { DAY_MS, LEVEL_ONE, type Limits } from "../core/limits";
import type { Created, NewDoc, Noted, Reading, Report, Store, Swept, Upload, Uploaded, Version } from "../core/store";

export interface Bindings {
  DB: D1Database;
  ENVELOPES: R2Bucket;
}

interface DocRow {
  edit_hash: string;
  anchor: string | null;
  latest: number;
  versions: string;
  blocked_at: number | null;
}

// A document being forgotten: nothing can move it on from here, and the sweep finishes it even after failing halfway.
const CLAIMED = -1;

const encoder = new TextEncoder();

const seenTable = (day: number): string => {
  if (!Number.isSafeInteger(day) || day < 0) throw new Error(`not a day: ${day}`);
  return `seen_${day}`;
};

const objectKey = (id: string, version: Pick<Version, "n" | "hash">): string => `${id}/${version.n}.${version.hash}`;

const sizeOf = (body: Upload["body"]): number =>
  typeof body === "string" ? encoder.encode(body).byteLength : body.byteLength;

export class Cloud implements Store {
  readonly #db: D1Database;
  readonly #envelopes: R2Bucket;
  readonly #limits: Limits;

  constructor(bindings: Bindings, limits: Limits = LEVEL_ONE) {
    this.#db = bindings.DB;
    this.#envelopes = bindings.ENVELOPES;
    this.#limits = limits;
  }

  async create(doc: NewDoc, today: number): Promise<Created> {
    if (!this.#limits.ttlChoices.includes(doc.ttlDays)) return "bad_ttl";
    const held = await this.#row(doc.id);
    if (held) return this.#retried(held, doc);
    if (!(await this.#takeQuota(doc.net, 1, 0, today))) return "quota";
    const inserted = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO docs (id, owner, anchor, edit_hash, admin_hash, ttl_days, dies_on, active_day)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE (?3 IS NOT NULL AND EXISTS (
           SELECT 1 FROM docs a WHERE a.id = ?3 AND a.owner = ?2 AND a.anchor IS NULL AND a.latest >= 0
         )) OR (?3 IS NULL AND (
           SELECT COUNT(*) FROM docs d
           WHERE d.owner = ?2 AND d.anchor IS NULL AND d.latest >= 0
             AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id)
         ) < ?9)`,
      )
      .bind(
        doc.id,
        doc.owner,
        doc.anchor ?? null,
        doc.editHash,
        doc.adminHash,
        doc.ttlDays,
        today + doc.ttlDays,
        today,
        this.#limits.sharesAtMost,
      )
      .run();
    if (inserted.meta.changes > 0) return "created";
    await this.#giveQuotaBack(doc.net, 1, 0, today);
    const raced = await this.#row(doc.id);
    if (raced) return this.#retried(raced, doc);
    return doc.anchor !== undefined ? "no_anchor" : "shares_full";
  }

  // A lost answer comes back as the same document, and only that is not somebody else's id.
  #retried(held: DocRow, doc: NewDoc): Created {
    return held.edit_hash === doc.editHash && held.latest !== CLAIMED ? "same" : "taken";
  }

  async upload(upload: Upload, today: number): Promise<Uploaded> {
    const held = await this.#row(upload.id);
    if (!held || held.latest === CLAIMED) return "missing";
    if (held.blocked_at !== null) return "blocked";
    const versions = JSON.parse(held.versions) as Version[];
    if (held.latest === upload.n && versions.at(-1)?.hash === upload.hash) return "same";
    if (upload.n !== held.latest + 1) return "behind";

    const bytes = sizeOf(upload.body);
    if (!(await this.#takeQuota(upload.net, 0, bytes, today))) return "quota";
    const version: Version = { n: upload.n, hash: upload.hash, bytes };
    const key = objectKey(upload.id, version);
    try {
      await this.#envelopes.put(key, upload.body);
    } catch (error) {
      await this.#giveQuotaBack(upload.net, 0, bytes, today);
      throw error;
    }

    const kept = [...versions, version].slice(-this.#limits.versionsKept);
    const alive = `dies_on = CASE WHEN paused_at IS NULL THEN MAX(dies_on, ?1 + ttl_days) ELSE dies_on END,
                   active_day = MAX(active_day, ?1)`;
    const [moved] = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE docs SET latest = ?2, versions = ?3, bytes = ?4, ${alive}
           WHERE id = ?5 AND latest = ?6 AND blocked_at IS NULL`,
        )
        .bind(
          today,
          upload.n,
          JSON.stringify(kept),
          kept.reduce((sum, one) => sum + one.bytes, 0),
          upload.id,
          upload.n - 1,
        ),
      // A new version of a language is activity of the whole group (decisions 50 and 69 bis).
      ...(held.anchor
        ? [
            this.#db
              .prepare(
                `UPDATE docs SET ${alive}
                 WHERE id = ?2 AND latest >= 0 AND EXISTS (SELECT 1 FROM docs l WHERE l.id = ?3 AND l.latest = ?4)`,
              )
              .bind(today, held.anchor, upload.id, upload.n),
          ]
        : []),
    ]);
    if ((moved?.meta.changes ?? 0) === 0) {
      await this.#giveQuotaBack(upload.net, 0, bytes, today);
      return this.#lostTheRace(upload, key);
    }

    const dropped = versions.slice(0, Math.max(0, versions.length + 1 - this.#limits.versionsKept));
    if (dropped.length > 0) await this.#envelopes.delete(dropped.map((one) => objectKey(upload.id, one)));
    return "stored";
  }

  async #lostTheRace(upload: Upload, key: string): Promise<Uploaded> {
    const now = await this.#row(upload.id);
    const versions = now ? (JSON.parse(now.versions) as Version[]) : [];
    // Two sends of the same bytes share one object, so the one that lost must not delete what the other kept.
    if (versions.some((one) => one.n === upload.n && one.hash === upload.hash)) return "same";
    await this.#envelopes.delete(key);
    if (!now || now.latest === CLAIMED) return "missing";
    return now.blocked_at === null ? "behind" : "blocked";
  }

  #row(id: string): Promise<DocRow | null> {
    return this.#db
      .prepare("SELECT edit_hash, anchor, latest, versions, blocked_at FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRow>();
  }

  async #takeQuota(net: string, docs: number, bytes: number, today: number): Promise<boolean> {
    if (docs > this.#limits.netDocsADay || bytes > this.#limits.netBytesADay) return false;
    const taken = await this.#db
      .prepare(
        `INSERT INTO net_day (day, net, docs, bytes) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (day, net) DO UPDATE SET docs = docs + excluded.docs, bytes = bytes + excluded.bytes
         WHERE docs + excluded.docs <= ?5 AND bytes + excluded.bytes <= ?6`,
      )
      .bind(today, net, docs, bytes, this.#limits.netDocsADay, this.#limits.netBytesADay)
      .run();
    return taken.meta.changes > 0;
  }

  async #giveQuotaBack(net: string, docs: number, bytes: number, today: number): Promise<void> {
    await this.#db
      .prepare("UPDATE net_day SET docs = docs - ?, bytes = bytes - ? WHERE day = ? AND net = ?")
      .bind(docs, bytes, today, net)
      .run();
  }

  async noteReader(reading: Reading, today: number): Promise<Noted> {
    try {
      return await this.#note(reading, today);
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
      await this.#db.prepare(this.#createSeen(today)).run();
      return this.#note(reading, today);
    }
  }

  async #note({ owner, reader, doc, proved }: Reading, today: number): Promise<Noted> {
    const table = seenTable(today);
    const found = await this.#db
      .prepare(
        `SELECT (SELECT 1 FROM ${table} WHERE owner = ?1 AND reader = ?2 AND doc = ?3) AS here,
                (SELECT 1 FROM ${table} WHERE owner = ?1 AND reader = ?2 LIMIT 1) AS known`,
      )
      .bind(owner, reader, doc)
      .first<{ here: number | null; known: number | null }>();
    if (found?.here) return "here";
    if (!found?.known) {
      const counted = await this.#db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT reader FROM ${table} WHERE owner = ? LIMIT ?)`)
        .bind(owner, this.#limits.newReadersFree)
        .first<{ n: number }>();
      if ((counted?.n ?? 0) >= this.#limits.newReadersFree) {
        // Only past the free readers does it count them all, so the usual reader reads a few hundred rows at most.
        const rows = await this.#db
          .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE owner = ? LIMIT ?)`)
          .bind(owner, this.#limits.rowsPerOwnerADay)
          .first<{ n: number }>();
        // Past the ceiling it answers without noting, so a farm of readers stops adding to the bill.
        if ((rows?.n ?? 0) >= this.#limits.rowsPerOwnerADay) return "full";
        if (!proved) return "over";
      }
    }
    await this.#db
      .prepare(`INSERT OR IGNORE INTO ${table} (owner, reader, doc) VALUES (?, ?, ?)`)
      .bind(owner, reader, doc)
      .run();
    return "noted";
  }

  #createSeen(day: number): string {
    return `CREATE TABLE IF NOT EXISTS ${seenTable(day)} (
      owner TEXT NOT NULL, reader TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (owner, reader, doc)
    ) WITHOUT ROWID`;
  }

  async report(report: Report, today: number): Promise<{ blocked: boolean }> {
    const [, blocked] = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO reports (doc, net, at, category, detail, sealed_link)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?1)
           ON CONFLICT (doc, net) DO UPDATE
             SET at = excluded.at, category = excluded.category, detail = excluded.detail,
                 sealed_link = excluded.sealed_link, cleared = 0
             WHERE cleared = 1`,
        )
        .bind(report.doc, report.net, today, report.category, report.detail ?? null, report.sealedLink ?? null),
      this.#db
        .prepare(
          `UPDATE docs SET blocked_at = ?1, dies_on = ?1 + ?2
           WHERE id = ?3 AND blocked_at IS NULL
             AND (SELECT COUNT(*) FROM reports r WHERE r.doc = ?3 AND r.cleared = 0) >= ?4`,
        )
        .bind(today, this.#limits.evidenceDays, report.doc, this.#limits.reportsToBlock),
    ]);
    return { blocked: (blocked?.meta.changes ?? 0) > 0 };
  }

  async appealAccepted(id: string, today: number): Promise<void> {
    await this.#db.batch([
      // The reports stay as evidence, but those networks can report again and the count starts over.
      this.#db
        .prepare(
          "UPDATE reports SET cleared = 1 WHERE doc = ?1 AND EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND blocked_at IS NOT NULL)",
        )
        .bind(id),
      this.#db
        .prepare(
          `UPDATE docs SET blocked_at = NULL, appealed_at = ?1,
             dies_on = CASE WHEN paused_at IS NULL THEN ?1 + ttl_days ELSE paused_at + ?2 END
           WHERE id = ?3 AND blocked_at IS NOT NULL`,
        )
        .bind(today, this.#limits.pausedDays, id),
    ]);
  }

  async pause(id: string, today: number): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE docs SET paused_at = ?1, dies_on = ?1 + ?2 WHERE id = ?3 AND blocked_at IS NULL AND paused_at IS NULL",
      )
      .bind(today, this.#limits.pausedDays, id)
      .run();
  }

  async resume(id: string, today: number): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE docs SET paused_at = NULL, dies_on = ?1 + ttl_days WHERE id = ?2 AND blocked_at IS NULL AND paused_at IS NOT NULL",
      )
      .bind(today, id)
      .run();
  }

  // Adds up first: what expired is only known once every past day has counted (decision 128).
  async sweep(today: number): Promise<Swept> {
    await this.#db.batch([this.#db.prepare(this.#createSeen(today)), this.#db.prepare(this.#createSeen(today + 1))]);
    const { summed, failed: failedDays } = await this.#sumPastDays(today);
    let forgotten = 0;
    let failed = failedDays;
    if (failedDays === 0) {
      for (const one of await this.#expired(today)) {
        try {
          if (await this.#forget(one.id, one.owner, today)) forgotten += 1;
        } catch (error) {
          failed += 1;
          console.error("a document could not be forgotten", String(error));
        }
      }
    }
    await this.#db.batch([
      this.#db.prepare("DELETE FROM net_day WHERE day < ?").bind(today),
      this.#db.prepare("DELETE FROM guesses WHERE slot < ?").bind(today * this.#limits.guessSlotsADay),
      this.#db.prepare("DELETE FROM reports WHERE at < ?").bind(today - this.#limits.evidenceDays),
    ]);
    return { summed, forgotten, failed };
  }

  async #sumPastDays(today: number): Promise<{ summed: number; failed: number }> {
    const tables = await this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'seen_[0-9]*'")
      .all<{ name: string }>();
    const days = tables.results
      .map((one) => Number(one.name.slice("seen_".length)))
      .filter((day) => day < today)
      .sort((a, b) => a - b);
    let summed = 0;
    let failed = 0;
    for (const day of days) {
      const table = seenTable(day);
      try {
        // In one batch, so a day is either counted and gone or still there to count: never lost, never counted twice.
        await this.#db.batch([
          this.#db
            .prepare(
              `UPDATE docs SET read_total = read_total + t.readers, active_day = MAX(active_day, ?1),
                 dies_on = CASE WHEN paused_at IS NULL AND blocked_at IS NULL
                   THEN MAX(dies_on, ?1 + ttl_days) ELSE dies_on END
               FROM (SELECT doc, COUNT(*) AS readers FROM ${table} GROUP BY doc) t
               WHERE docs.id = t.doc`,
            )
            .bind(day),
          this.#db.prepare(`DROP TABLE ${table}`),
        ]);
        summed += 1;
      } catch (error) {
        failed += 1;
        console.error("a day could not be added up", day, String(error));
      }
    }
    return { summed, failed };
  }

  async #expired(today: number): Promise<{ id: string; owner: string }[]> {
    const expired = await this.#db
      .prepare(
        `SELECT d.id, d.owner FROM docs d
         WHERE d.latest = ${CLAIMED} OR (
           d.dies_on < ?1
           AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = d.id)
           AND (d.anchor IS NULL OR d.blocked_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM docs a WHERE a.id = d.anchor))
           AND NOT EXISTS (
             SELECT 1 FROM docs l WHERE l.owner = d.owner AND l.anchor = d.id
               AND ((l.blocked_at IS NOT NULL AND l.dies_on >= ?1)
                 OR EXISTS (SELECT 1 FROM holds h WHERE h.held = l.id))
           )
         )
         ORDER BY d.latest = ${CLAIMED} DESC, d.dies_on LIMIT ?2`,
      )
      .bind(today, this.#limits.sweptAtOnce)
      .all<{ id: string; owner: string }>();
    return expired.results;
  }

  // Claims the row before touching R2, so an upload or a hold that arrived after the list saves the document.
  async #forget(id: string, owner: string, today: number): Promise<boolean> {
    const claimed = await this.#db
      .prepare(
        `UPDATE docs SET latest = ${CLAIMED}
         WHERE id = ?1 AND (latest = ${CLAIMED} OR (
           dies_on < ?2 AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.held = ?1)
         ))`,
      )
      .bind(id, today)
      .run();
    if (claimed.meta.changes === 0) return false;
    const languages = await this.#db
      .prepare("SELECT id FROM docs WHERE owner = ? AND anchor = ?")
      .bind(owner, id)
      .all<{ id: string }>();
    const ids = [id, ...languages.results.map((one) => one.id)];
    if (ids.length > 1) {
      await this.#db
        .prepare(`UPDATE docs SET latest = ${CLAIMED} WHERE owner = ? AND anchor = ?`)
        .bind(owner, id)
        .run();
    }
    for (const one of ids) await this.#deleteObjects(one);
    await this.#db.batch(
      ids.flatMap((one) => [
        this.#db.prepare("DELETE FROM holds WHERE holder = ? OR held = ?").bind(one, one),
        this.#db.prepare("DELETE FROM docs WHERE id = ?").bind(one),
      ]),
    );
    return true;
  }

  // Lists instead of reading the versions, so an upload that died halfway leaves nothing behind.
  async #deleteObjects(id: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#envelopes.list({ prefix: `${id}/`, cursor });
      if (page.objects.length > 0) await this.#envelopes.delete(page.objects.map((one) => one.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  // After D1 goes back in time, what came later stays in R2 with no row, paying for storage where nothing lists it.
  async forgetOrphans(now: number): Promise<number> {
    let forgotten = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#envelopes.list({ cursor });
      const idOf = (key: string): string => key.split("/", 1)[0] ?? key;
      const ids = [...new Set(page.objects.map((one) => idOf(one.key)))];
      const held = await this.#db
        .prepare("SELECT id FROM docs WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all<{ id: string }>();
      const known = new Set(held.results.map((one) => one.id));
      const old = now - DAY_MS;
      const orphans = page.objects.filter((one) => !known.has(idOf(one.key)) && one.uploaded.getTime() < old);
      if (orphans.length > 0) await this.#envelopes.delete(orphans.map((one) => one.key));
      forgotten += orphans.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return forgotten;
  }
}

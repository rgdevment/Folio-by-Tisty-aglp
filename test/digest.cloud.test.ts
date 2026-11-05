import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail } from "../src/cloudflare/mail";
import { Cloud } from "../src/cloudflare/store";
import { sendDigest } from "../src/core/digest";
import { dayOf } from "../src/core/limits";
import worker from "../src/private/index";

const testEnv = env as unknown as {
  DB: D1Database;
  ENVELOPES: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const store = new Cloud(testEnv);
const NOW = Date.UTC(2026, 10, 20, 12);
const TODAY = dayOf(NOW);
const ID = "k7Qm2xPa";
const OTHER = "wordsOnl";

const share = (id: string) =>
  store.create({ id, owner: "o1", editHash: "e", adminHash: "a", ttlDays: 3, net: "n" }, TODAY - 5);
const report = (doc: string, net: string, category: string, day = TODAY - 1) =>
  store.report({ doc, net, asn: 1, category }, day);

const digest = (send = vi.fn(async (_subject: string, _text: string) => {})) =>
  sendDigest(NOW, { store, send }).then((sent) => ({ sent, send }));

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["docs", "reports", "holds", "service_stage"]) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await share(ID);
  await share(OTHER);
});

describe("the daily mail", () => {
  it("does not go when there is nothing to tell, and writes nothing", async () => {
    const { sent, send } = await digest();
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect((await store.digested()).day).toBe(0);
  });

  it("tells of each document and how many networks reported it", async () => {
    await report(ID, "n1", "phishing");
    await report(ID, "n2", "phishing");
    await report(OTHER, "n3", "malware");
    const { send } = await digest();
    const [subject, text] = send.mock.calls[0] as [string, string];
    expect(subject).toBe("Folio: resumen");
    expect(text).toContain(`phishing: ${ID}, 2 redes`);
    expect(text).toContain(`malware: ${OTHER}, 1 red`);
  });

  it("puts CSAM first, and says so in the subject", async () => {
    await report(ID, "n1", "phishing");
    await report(ID, "n2", "phishing");
    await report(OTHER, "n3", "csam");
    const { send } = await digest();
    const [subject, text] = send.mock.calls[0] as [string, string];
    expect(subject).toBe("Folio: resumen, con CSAM");
    expect(text.indexOf("csam")).toBeLessThan(text.indexOf("phishing"));
  });

  it("goes once for the same news, and tells of today's the next day", async () => {
    await report(ID, "n1", "csam");
    await report(OTHER, "n2", "csam", TODAY);
    expect((await digest()).sent).toBe(true);
    expect((await digest()).sent).toBe(false);

    const send = vi.fn(async (_subject: string, _text: string) => {});
    await sendDigest(NOW + 86_400_000, { store, send });
    expect(send).toHaveBeenCalledOnce();
    const text = send.mock.calls[0]?.[1] as string;
    expect(text).toContain(OTHER);
    expect(text).not.toContain(ID);
  });

  it("tells it all the next day when the mail fails", async () => {
    await report(ID, "n1", "csam");
    const failing = vi.fn(async () => {
      throw new Error("no mail");
    });
    await expect(sendDigest(NOW, { store, send: failing })).rejects.toThrow("no mail");

    const send = vi.fn(async (_subject: string, _text: string) => {});
    await sendDigest(NOW + 86_400_000, { store, send });
    expect(send.mock.calls[0]?.[1]).toContain(ID);
  });

  it("does not tell of reports an accepted appeal cleared", async () => {
    await report(ID, "n1", "phishing");
    await testEnv.DB.prepare("UPDATE reports SET cleared = 1").run();
    expect((await digest()).sent).toBe(false);
  });

  it("tells of a block and an appeal", async () => {
    await testEnv.DB.prepare(`UPDATE docs SET blocked_at = ?, appealed_at = ? WHERE id = '${ID}'`)
      .bind(TODAY - 1, TODAY - 1)
      .run();
    const { send } = await digest();
    const text = send.mock.calls[0]?.[1] as string;
    expect(text).toContain(`Bloqueados:\n${ID}`);
    expect(text).toContain(`Reclamos:\n${ID}`);
  });

  it("tells of the spending stage only when it changed", async () => {
    await store.setStage("blocked");
    const { send } = await digest();
    expect(send.mock.calls[0]?.[1]).toContain("Gasto: blocked (antes: open)");
    expect((await digest()).sent).toBe(false);
    expect(await store.stage()).toBe("blocked");
  });

  it("never holds the words of a document or who reported it", async () => {
    await store.report(
      { doc: ID, net: "a-network", asn: 1, category: "csam", detail: "palabras", sealedLink: "llave" },
      TODAY - 1,
    );
    const { send } = await digest();
    const text = send.mock.calls[0]?.[1] as string;
    for (const hidden of ["a-network", "palabras", "llave"]) expect(text).not.toContain(hidden);
  });

  it("says when it could not fit them all", async () => {
    const reports = Array.from({ length: 60 }, (_, at) => `('${ID}', 'net${at}', ${TODAY - 1}, 'phishing', 1)`);
    const others = Array.from({ length: 60 }, (_, at) => `('doc${at}', 'net', ${TODAY - 1}, 'phishing', 1)`);
    await testEnv.DB.prepare(
      `INSERT INTO reports (doc, net, at, category, asn) VALUES ${[...reports, ...others].join()}`,
    ).run();
    const { send } = await digest();
    expect(send.mock.calls[0]?.[1]).toContain("(hay más)");
  });
});

describe("sending it", () => {
  const email = () => ({ send: vi.fn(async () => ({ messageId: "m" })) });

  it("goes from and to where it is set", async () => {
    const EMAIL = email();
    await sendMail({ EMAIL, ALERT_FROM: "avisos@tisty.cl", ALERT_TO: "persona@example.com" }, "Asunto", "Texto");
    expect(EMAIL.send).toHaveBeenCalledExactlyOnceWith({
      to: "persona@example.com",
      from: "avisos@tisty.cl",
      subject: "Asunto",
      text: "Texto",
    });
  });

  it("fails when there is nobody to tell", async () => {
    await expect(sendMail({ EMAIL: email(), ALERT_FROM: "avisos@tisty.cl" }, "A", "B")).rejects.toThrow(
      "there is nowhere to send the mail",
    );
  });
});

describe("the daily round", () => {
  const scheduled = async (more: object) => {
    await worker.scheduled(
      { cron: "0 12 * * *", scheduledTime: NOW, noRetry: () => {} } as never,
      { ...testEnv, ALERT_FROM: "avisos@tisty.cl", ...more } as never,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the mail, and the heartbeat says it went", async () => {
    await report(ID, "n1", "csam");
    const beat = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const EMAIL = { send: vi.fn(async () => ({ messageId: "m" })) };
    await scheduled({ EMAIL, ALERT_TO: "persona@example.com", DIGEST_HEARTBEAT_URL: "https://beat.example/d" });
    expect(EMAIL.send).toHaveBeenCalledOnce();
    expect(beat).toHaveBeenCalledExactlyOnceWith("https://beat.example/d");
  });

  it("sends no heartbeat when the mail fails, and that is the alert", async () => {
    await report(ID, "n1", "csam");
    const beat = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const EMAIL = { send: vi.fn(async () => Promise.reject(new Error("no mail"))) };
    await expect(
      scheduled({ EMAIL, ALERT_TO: "persona@example.com", DIGEST_HEARTBEAT_URL: "https://beat.example/d" }),
    ).rejects.toThrow("no mail");
    expect(beat).not.toHaveBeenCalled();
  });
});

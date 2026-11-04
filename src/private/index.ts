import { CloudSpend, type SpendBindings } from "../cloudflare/spend";
import { type Bindings, Cloud } from "../cloudflare/store";
import { dayOf, LEVEL_ONE } from "../core/limits";
import { DayKeys } from "../core/net";
import { checkSpend } from "../core/spend";
import { answer } from "./api";

interface Env extends Bindings, SpendBindings {
  FOLIO_SECRET: string;
  READS: RateLimit;
  BILLING_DAY: string;
  HEARTBEAT_URL?: string;
  SPEND_HEARTBEAT_URL?: string;
  ALERT_URL?: string;
}

const WEEKLY = "0 4 * * 0";
const SPEND = "*/15 * * * *";
const dayKeys = new DayKeys();
const evidenceKeys = new DayKeys();

const sendAlert = async (env: Env, said: unknown): Promise<void> => {
  if (!env.ALERT_URL) {
    console.error("an alert with nowhere to go");
    return;
  }
  const alert = await fetch(env.ALERT_URL, { method: "POST", body: JSON.stringify(said) });
  if (!alert.ok) throw new Error(`the alert was refused: ${alert.status}`);
};

const reviewSpend = async (now: number, env: Env): Promise<void> => {
  const spend = new CloudSpend(env);
  const stage = await checkSpend(now, Number(env.BILLING_DAY), {
    store: new Cloud(env),
    usageSince: (start, until) => spend.usageSince(start, until),
    setBlocked: (blocked) => spend.setBlocked(blocked),
    notify: async (said) => {
      console.log(JSON.stringify(said));
      await sendAlert(env, said);
    },
  });
  console.log(JSON.stringify({ stage }));
  // It stops arriving when the review fails, and that is the alert: without it nothing cuts the bill.
  if (env.SPEND_HEARTBEAT_URL) await fetch(env.SPEND_HEARTBEAT_URL);
};

export default {
  async fetch(request, env, context): Promise<Response> {
    const store = new Cloud(env);
    const started = Date.now();
    const response = await answer(request, {
      now: started,
      waitUntil: (work) => context.waitUntil(work),
      tools: {
        store,
        limits: LEVEL_ONE,
        secret: env.FOLIO_SECRET,
        limiter: { allows: async (key) => (await env.READS.limit({ key })).success },
        dayKey: (today) => dayKeys.of(today, (day) => store.dayKey(day)),
        evidenceKey: (today) => evidenceKeys.of(today, (day) => store.evidenceKey(day)),
        alert: (said) => sendAlert(env, said),
      },
    });
    response.headers.set("Server-Timing", `total;dur=${Date.now() - started}`);
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === SPEND) {
      await reviewSpend(controller.scheduledTime, env);
      return;
    }
    const store = new Cloud(env);
    if (controller.cron === WEEKLY) {
      console.log(JSON.stringify({ orphans: await store.forgetOrphans(controller.scheduledTime) }));
      return;
    }
    const swept = await store.sweep(dayOf(controller.scheduledTime));
    // Only numbers, never an id (decision 98). The heartbeat stops arriving when a sweep fails, and that is the alert.
    console.log(JSON.stringify(swept));
    if (swept.failed === 0 && env.HEARTBEAT_URL) await fetch(env.HEARTBEAT_URL);
  },
} satisfies ExportedHandler<Env>;

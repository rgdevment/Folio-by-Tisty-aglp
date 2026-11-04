import { type Bindings, Cloud } from "../cloudflare/store";
import { dayOf, LEVEL_ONE } from "../core/limits";
import { DayKeys } from "../core/net";
import { answer } from "./api";

interface Env extends Bindings {
  FOLIO_SECRET: string;
  READS: RateLimit;
  HEARTBEAT_URL?: string;
}

const WEEKLY = "0 4 * * 0";
const dayKeys = new DayKeys();

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
      },
    });
    response.headers.set("Server-Timing", `total;dur=${Date.now() - started}`);
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
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

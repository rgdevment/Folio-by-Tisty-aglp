import { type Bindings, Cloud } from "../cloudflare/store";
import { dayOf } from "../core/limits";

interface Env extends Bindings {
  HEARTBEAT_URL?: string;
}

const WEEKLY = "0 4 * * 0";

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
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

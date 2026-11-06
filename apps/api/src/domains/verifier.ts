/*
 * Background domain verifier (T3.6): one in-process interval loop. All state is in the database (dns_check.checkedAt,
 * created_at, last_verify_requested_at), so a restart loses nothing. For every unverified domain it runs a full check
 * (service.runCheck) when the backoff says it is due: every 15 s for 10 min after creation or a verify request, every
 * 2 min up to 2 h, every 15 min up to 72 h, then it stops (the user can press "Check now", which restarts the clock).
 */
import { listUnverifiedUserDomains, type Db } from "@nanite/db";
import type { DomainService } from "./service.js";
import { nextCheckAt } from "./view.js";

export interface DomainVerifierOptions {
  db: Db;
  service: DomainService;
  log: (line: string) => void;
  /** Loop period. Default 5 s (the finest backoff step is 15 s). */
  tickMs?: number;
  now?: () => Date;
}

export function createDomainVerifier(opts: DomainVerifierOptions) {
  const now = () => (opts.now ? opts.now() : new Date());
  const inFlight = new Set<string>();
  let running: Promise<void> = Promise.resolve();

  /** One pass. Returns the resend ids that were checked (for tests and logs). */
  async function tick(): Promise<string[]> {
    const rows = await listUnverifiedUserDomains(opts.db);
    const checked: string[] = [];
    const t = now();
    await Promise.all(
      rows.map(async (row) => {
        if (inFlight.has(row.id)) return;
        const due = nextCheckAt(row, t);
        if (!due || due > t) return;
        inFlight.add(row.id);
        checked.push(row.resendDomainId);
        try {
          await opts.service.runCheck(row);
        } catch {
          opts.log(JSON.stringify({ level: "error", component: "domains", event: "check_failed", resendDomainId: row.resendDomainId }));
        } finally {
          inFlight.delete(row.id);
        }
      }),
    );
    return checked;
  }

  return {
    tick,
    /** Starts the loop; returns the stop function. Passes never overlap. */
    start(): () => void {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        running = tick()
          .then(() => undefined)
          .catch(() => opts.log(JSON.stringify({ level: "error", component: "domains", event: "tick_failed" })))
          .finally(() => {
            busy = false;
          });
      }, opts.tickMs ?? 5000);
      timer.unref();
      return () => clearInterval(timer);
    },
    idle: () => running,
  };
}
export type DomainVerifier = ReturnType<typeof createDomainVerifier>;

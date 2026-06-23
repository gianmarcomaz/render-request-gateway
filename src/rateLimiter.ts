import { DurableObject } from "cloudflare:workers";
import type { RateLimitDecision } from "./types";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10;

interface CounterRow extends Record<string, SqlStorageValue> {
  window_start: number;
  count: number;
}

export class RateLimiter extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL
        )`,
      );
      this.sql.exec("INSERT OR IGNORE INTO counters (id, window_start, count) VALUES (1, 0, 0)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    return Response.json(this.check(Date.now()));
  }

  private check(nowMs: number): RateLimitDecision {
    const nowSeconds = Math.floor(nowMs / 1000);
    const row = this.sql
      .exec<CounterRow>("SELECT window_start, count FROM counters WHERE id = 1")
      .one();

    let windowStart = row.window_start;
    let count = row.count;

    if (windowStart === 0 || nowSeconds - windowStart >= WINDOW_SECONDS) {
      windowStart = nowSeconds;
      count = 0;
    }

    if (count >= MAX_REQUESTS) {
      return { allowed: false, retry_after: Math.max(1, windowStart + WINDOW_SECONDS - nowSeconds) };
    }

    count += 1;

    // The DO handles one workspace at a time, so this read/update cannot race.
    this.sql.exec("UPDATE counters SET window_start = ?, count = ? WHERE id = 1", windowStart, count);

    // Swap this fixed window for sliding-window logs or token buckets if burst fairness matters.
    return { allowed: true, retry_after: 0 };
  }
}

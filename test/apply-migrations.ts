import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

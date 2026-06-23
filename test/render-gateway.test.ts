import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const WORKSPACE_A_KEY = crypto.randomUUID();
const WORKSPACE_B_KEY = crypto.randomUUID();
const API_URL = "https://gateway.test";

describe("Render Request Gateway", () => {
  beforeEach(async () => {
    env.API_KEY_HASHES_JSON = "{}";
    await seedAuth(WORKSPACE_A_KEY, "workspace_a");
    await seedAuth(WORKSPACE_B_KEY, "workspace_b");
  });

  it("accepts a POST under the limit", async () => {
    const response = await fetchWorker("/v1/renders", {
      method: "POST",
      apiKey: WORKSPACE_A_KEY,
      body: { asset_id: "asset-1", preset: "1080p" },
    });

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { render_id: string; status: string };
    expect(payload.render_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.status).toBe("queued");
  });

  it("rate limits the 11th request in a window", async () => {
    const workspaceKey = `${WORKSPACE_A_KEY}-rate-limit`;
    await seedAuth(workspaceKey, "workspace_rate_limit");

    for (let index = 0; index < 10; index += 1) {
      const response = await fetchWorker("/v1/renders", {
        method: "POST",
        apiKey: workspaceKey,
        body: { asset_id: `asset-${index}`, preset: "720p" },
      });
      expect(response.status).toBe(202);
    }

    const denied = await fetchWorker("/v1/renders", {
      method: "POST",
      apiKey: workspaceKey,
      body: { asset_id: "asset-11", preset: "720p" },
    });

    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("returns recent items newest first while respecting limit", async () => {
    const workspaceKey = `${WORKSPACE_A_KEY}-list`;
    await seedAuth(workspaceKey, "workspace_list");

    await createRender(workspaceKey, "asset-old", "480p");
    await createRender(workspaceKey, "asset-middle", "720p");
    await createRender(workspaceKey, "asset-new", "1080p");

    const response = await fetchWorker("/v1/renders?limit=2", {
      method: "GET",
      apiKey: workspaceKey,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { renders: Array<{ asset_id: string; preset: string }> };
    expect(payload.renders).toHaveLength(2);
    expect(payload.renders.map((render) => render.asset_id)).toEqual(["asset-new", "asset-middle"]);
  });

  it("persists a render to D1 beyond the request execution context", async () => {
    const workspaceKey = `${WORKSPACE_A_KEY}-persistence`;
    const workspaceId = "workspace_persistence";
    const assetId = `asset-persist-${crypto.randomUUID()}`;
    await seedAuth(workspaceKey, workspaceId);

    const created = await fetchWorker("/v1/renders", {
      method: "POST",
      apiKey: workspaceKey,
      body: { asset_id: assetId, preset: "1080p" },
    });

    expect(created.status).toBe(202);
    const createdPayload = (await created.json()) as { render_id: string; status: string };

    // Vitest Pool Workers has no public API for restarting only this Worker inside a test.
    // Reading through env.DB proves the request committed to D1, not only module memory.
    const stored = await env.DB
      .prepare(
        `SELECT render_id, workspace_id, asset_id, preset, created_at
         FROM renders
         WHERE workspace_id = ? AND render_id = ?
         LIMIT 1`,
      )
      .bind(workspaceId, createdPayload.render_id)
      .first<{
        render_id: string;
        workspace_id: string;
        asset_id: string;
        preset: string;
        created_at: string;
      }>();

    expect(stored).toMatchObject({
      render_id: createdPayload.render_id,
      workspace_id: workspaceId,
      asset_id: assetId,
      preset: "1080p",
    });
    expect(stored?.created_at).toEqual(expect.any(String));

    const listed = await fetchWorker("/v1/renders?limit=100", {
      method: "GET",
      apiKey: workspaceKey,
    });
    const listedPayload = (await listed.json()) as { renders: Array<{ render_id: string }> };
    expect(listedPayload.renders.map((render) => render.render_id)).toContain(createdPayload.render_id);
  });

  it("rejects missing and invalid API keys", async () => {
    const missing = await fetchWorker("/v1/renders", { method: "GET" });
    expect(missing.status).toBe(401);

    const invalid = await fetchWorker("/v1/renders", {
      method: "GET",
      apiKey: "not-a-real-key",
    });
    expect(invalid.status).toBe(401);
  });

  it("isolates tenants by workspace", async () => {
    await createRender(WORKSPACE_A_KEY, "workspace-a-asset", "1080p");
    await createRender(WORKSPACE_B_KEY, "workspace-b-asset", "720p");

    const response = await fetchWorker("/v1/renders", {
      method: "GET",
      apiKey: WORKSPACE_A_KEY,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { renders: Array<{ asset_id: string }> };
    expect(payload.renders.map((render) => render.asset_id)).toContain("workspace-a-asset");
    expect(payload.renders.map((render) => render.asset_id)).not.toContain("workspace-b-asset");
  });

  it("returns the same render_id for a replayed Idempotency-Key", async () => {
    const first = await fetchWorker("/v1/renders", {
      method: "POST",
      apiKey: WORKSPACE_A_KEY,
      idempotencyKey: "idem-1",
      body: { asset_id: "asset-idem", preset: "1080p" },
    });
    const second = await fetchWorker("/v1/renders", {
      method: "POST",
      apiKey: WORKSPACE_A_KEY,
      idempotencyKey: "idem-1",
      body: { asset_id: "asset-idem", preset: "1080p" },
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const firstPayload = (await first.json()) as { render_id: string };
    const secondPayload = (await second.json()) as { render_id: string };
    expect(secondPayload.render_id).toBe(firstPayload.render_id);
  });
});

async function createRender(apiKey: string, assetId: string, preset: string): Promise<Response> {
  const response = await fetchWorker("/v1/renders", {
    method: "POST",
    apiKey,
    body: { asset_id: assetId, preset },
  });
  expect(response.status).toBe(202);
  return response;
}

async function fetchWorker(
  path: string,
  options: {
    method: "GET" | "POST";
    apiKey?: string;
    idempotencyKey?: string;
    body?: unknown;
  },
): Promise<Response> {
  const headers = new Headers();
  if (options.apiKey) {
    headers.set("Authorization", `Bearer ${options.apiKey}`);
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const requestInit: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }

  const request = new Request(`${API_URL}${path}`, requestInit) as Request<unknown, IncomingRequestCfProperties>;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedAuth(apiKey: string, workspaceId: string): Promise<void> {
  const hash = await sha256Hex(apiKey);
  const current = JSON.parse(env.API_KEY_HASHES_JSON) as Record<string, string>;
  env.API_KEY_HASHES_JSON = JSON.stringify({ ...current, [hash]: workspaceId });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

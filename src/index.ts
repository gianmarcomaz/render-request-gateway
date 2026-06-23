export { RateLimiter } from "./rateLimiter";

import { resolveWorkspaceId } from "./auth";
import {
  findIdempotentRender,
  insertRender,
  insertRenderWithIdempotency,
  listRenders,
} from "./db";
import { HttpError, PRESETS, type CreateRenderBody, type RateLimitDecision } from "./types";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

interface RequestLog {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  workspace_id: string | null;
  status: number;
  duration_ms: number;
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const startedAt = performance.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let workspaceId: string | null = null;
    let status = 500;

    try {
      const response = await routeRequest(request, env, url, requestId, (resolvedWorkspaceId) => {
        workspaceId = resolvedWorkspaceId;
      });
      status = response.status;
      return response;
    } catch (error) {
      const response = handleError(error, requestId);
      status = response.status;
      return response;
    } finally {
      logRequest({
        timestamp: new Date().toISOString(),
        request_id: requestId,
        method: request.method,
        path: url.pathname,
        workspace_id: workspaceId,
        status,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  setWorkspaceId: (workspaceId: string) => void,
): Promise<Response> {
  if (url.pathname === "/health") {
    if (request.method === "GET") {
      return json({ status: "ok" }, 200, requestId);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
  }

  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    throw new HttpError(401, "unauthorized", "Unauthorized");
  }
  setWorkspaceId(workspaceId);

  if (request.method === "POST" && url.pathname === "/v1/renders") {
    return createRender(request, env, workspaceId, requestId);
  }

  if (request.method === "GET" && url.pathname === "/v1/renders") {
    return getRenders(env, url, workspaceId, requestId);
  }

  if (url.pathname === "/v1/renders" || url.pathname === "/health") {
    throw new HttpError(405, "method_not_allowed", "Method not allowed", { Allow: allowedMethods(url.pathname) });
  }

  throw new HttpError(404, "not_found", "Not found");
}

async function createRender(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const body = await readCreateRenderBody(request);
  const idempotencyKey = parseIdempotencyKey(request.headers.get("Idempotency-Key"));
  const now = new Date();

  if (idempotencyKey) {
    const existingRenderId = await findIdempotentRender(env.DB, workspaceId, idempotencyKey, now);
    if (existingRenderId) {
      return json({ render_id: existingRenderId, status: "queued" }, 202, requestId);
    }
  }

  const rateLimit = await checkRateLimit(env, workspaceId);
  if (!rateLimit.allowed) {
    throw new HttpError(429, "rate_limited", "Rate limit exceeded", {
      "Retry-After": String(rateLimit.retry_after),
    });
  }

  const renderId = crypto.randomUUID();
  const createdAt = now.toISOString();
  const persistedRenderId = idempotencyKey
    ? await insertRenderWithIdempotency(env.DB, workspaceId, body, idempotencyKey, renderId, createdAt)
    : await insertRender(env.DB, workspaceId, body, renderId, createdAt).then(() => renderId);

  return json({ render_id: persistedRenderId, status: "queued" }, 202, requestId);
}

async function getRenders(env: Env, url: URL, workspaceId: string, requestId: string): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"));
  const renders = await listRenders(env.DB, workspaceId, limit);
  return json({ renders }, 200, requestId);
}

async function checkRateLimit(env: Env, workspaceId: string): Promise<RateLimitDecision> {
  const id = env.RATE_LIMITER.idFromName(workspaceId);
  const stub = env.RATE_LIMITER.get(id);
  const response = await stub.fetch("https://rate-limit.local/check", { method: "POST" });

  if (!response.ok) {
    throw new Error("Rate limiter failed");
  }

  return (await response.json()) as RateLimitDecision;
}

async function readCreateRenderBody(request: Request): Promise<CreateRenderBody> {
  assertJsonContentType(request.headers.get("Content-Type"));

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Request body too large");
  }

  const rawBody = await readBodyWithLimit(request, MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "invalid_json", "Malformed JSON body");
  }

  return validateCreateRenderBody(parsed);
}

function validateCreateRenderBody(parsed: unknown): CreateRenderBody {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "bad_request", "Expected a JSON object");
  }

  const entries = Object.keys(parsed);
  if (entries.length !== 2 || !entries.includes("asset_id") || !entries.includes("preset")) {
    throw new HttpError(400, "bad_request", "Body must include only asset_id and preset");
  }

  const body = parsed as Record<string, unknown>;
  const assetId = validateStringField(body.asset_id, "asset_id");
  const preset = validateStringField(body.preset, "preset");

  if (!PRESETS.includes(preset as CreateRenderBody["preset"])) {
    throw new HttpError(400, "bad_request", "Invalid preset");
  }

  return { asset_id: assetId, preset: preset as CreateRenderBody["preset"] };
}

function validateStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_FIELD_LENGTH) {
    throw new HttpError(400, "bad_request", `${fieldName} must be a non-empty string up to 128 characters`);
  }

  return value;
}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "payload_too_large", "Request body too large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function assertJsonContentType(contentType: string | null): void {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!mediaType || (mediaType !== "application/json" && !mediaType.endsWith("+json"))) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
}

function parseIdempotencyKey(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new HttpError(400, "bad_request", "Invalid Idempotency-Key");
  }

  return trimmed;
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return 50;
  }

  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 100");
  }

  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 100");
  }

  return limit;
}

function handleError(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status, requestId, error.headers);
  }

  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", request_id: requestId }));
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500, requestId);
}

function json(payload: unknown, status: number, requestId: string, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Request-Id", requestId);

  return Response.json(payload, {
    status,
    headers: responseHeaders,
  });
}

function allowedMethods(pathname: string): string {
  if (pathname === "/health" || pathname === "/v1/renders") {
    return pathname === "/health" ? "GET" : "GET, POST";
  }

  return "";
}

function logRequest(log: RequestLog): void {
  console.log(JSON.stringify(log));
}

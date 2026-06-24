# Render Request Gateway

Render Request Gateway is a small Cloudflare backend for Wayframe. It accepts render requests, applies per-workspace rate limits, persists queued work, and lets a workspace list its own recent renders.

## Architecture

- Cloudflare Workers are the HTTP entry point: routing, auth, validation, errors, and request logging live in `src/index.ts`.
- Durable Objects enforce per-workspace rate limits. `env.RATE_LIMITER.idFromName(workspace_id)` sends all requests for one workspace to one object, which makes the fixed-window counter race-free.
- Durable Object storage uses the SQLite backend via `new_sqlite_classes`, leaving room for richer rate-limit state later.
- D1 stores render requests because they are relational, queryable by workspace and time, and should survive deploys. Idempotency keys are also stored in D1 with a short expiry, scoped by workspace.

## Setup

Install dependencies:

```sh
npm install
```

Create a D1 database and put the returned `database_id` in `wrangler.jsonc`:

```sh
npx wrangler d1 create wayframe_render_requests
```

Apply migrations locally:

```sh
npx wrangler d1 migrations apply wayframe_render_requests --local
```

Generate Worker binding types after changing `wrangler.jsonc`:

```sh
npm run cf-typegen
```

Create `.dev.vars` from `.dev.vars.example`. Store API keys only as SHA-256 hashes:

```sh
node -e "const { createHash } = require('crypto'); console.log(createHash('sha256').update(process.argv[1]).digest('hex'))" "your-local-api-key"
```

## Run

```sh
npm run dev
```

The deployed Worker is live at `https://render-request-gateway.gianmarcomazzella.workers.dev`.
Health check (no auth): open `https://render-request-gateway.gianmarcomazzella.workers.dev/health` to see `{"status":"ok"}`.
All other routes require a Bearer API key, so requesting the base URL without one correctly returns 401.
For local development, `npm run dev` starts Wrangler at `http://localhost:8787`.

## Test

```sh
npm test
```

Tests use `@cloudflare/vitest-pool-workers` with real D1 and Durable Object bindings, and apply `migrations/0001_init.sql` before each test.

## Curl Examples

Queue a render:

```sh
curl -i https://render-request-gateway.gianmarcomazzella.workers.dev/v1/renders \
  -H "Authorization: Bearer wayframe_demo_key_a" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-request-1" \
  -d '{"asset_id":"asset_123","preset":"1080p"}'
```

Trigger the 10 requests per 60 seconds limit:

```sh
for i in $(seq 1 11); do
  curl -i https://render-request-gateway.gianmarcomazzella.workers.dev/v1/renders \
    -H "Authorization: Bearer wayframe_demo_key_a" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"asset_$i\",\"preset\":\"720p\"}"
done
```

List recent renders:

```sh
curl -i "https://render-request-gateway.gianmarcomazzella.workers.dev/v1/renders?limit=50" \
  -H "Authorization: Bearer wayframe_demo_key_a"
```

## Production Considerations / What I'd Do Next

- Add request fingerprinting to idempotency keys so reusing a key with a different body returns a clear conflict.
- Move API key hash management to a small admin workflow or secrets-backed deployment process.
- Add alerting on 5xx responses, rate-limit denials, and D1 write failures.
- Add pagination with a cursor once render history grows beyond "recent requests."

import type { CreateRenderBody, Preset, RenderRecord } from "./types";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

interface IdempotencyRow {
  render_id: string;
}

interface RenderRow {
  render_id: string;
  asset_id: string;
  preset: Preset;
  created_at: string;
}

export async function findIdempotentRender(
  db: D1Database,
  workspaceId: string,
  idempotencyKey: string,
  now: Date,
): Promise<string | null> {
  await deleteExpiredIdempotencyKeys(db, workspaceId, now);

  const row = await db
    .prepare(
      `SELECT render_id
       FROM idempotency_keys
       WHERE workspace_id = ? AND key = ? AND expires_at > ?
       LIMIT 1`,
    )
    .bind(workspaceId, idempotencyKey, now.toISOString())
    .first<IdempotencyRow>();

  return row?.render_id ?? null;
}

export async function insertRender(
  db: D1Database,
  workspaceId: string,
  body: CreateRenderBody,
  renderId: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO renders (render_id, workspace_id, asset_id, preset, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(renderId, workspaceId, body.asset_id, body.preset, createdAt)
    .run();
}

export async function insertRenderWithIdempotency(
  db: D1Database,
  workspaceId: string,
  body: CreateRenderBody,
  idempotencyKey: string,
  renderId: string,
  createdAt: string,
): Promise<string> {
  const created = new Date(createdAt);
  const expiresAt = new Date(created.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();

  // D1 batch is transactional, so the idempotency mapping and render row commit together.
  await db.batch([
    db
      .prepare(
        `DELETE FROM idempotency_keys
         WHERE workspace_id = ? AND key = ? AND expires_at <= ?`,
      )
      .bind(workspaceId, idempotencyKey, createdAt),
    db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (workspace_id, key, render_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, idempotencyKey, renderId, expiresAt, createdAt),
    db
      .prepare(
        `INSERT INTO renders (render_id, workspace_id, asset_id, preset, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM idempotency_keys
           WHERE workspace_id = ? AND key = ? AND render_id = ?
         )`,
      )
      .bind(
        renderId,
        workspaceId,
        body.asset_id,
        body.preset,
        createdAt,
        workspaceId,
        idempotencyKey,
        renderId,
      ),
  ]);

  const row = await db
    .prepare(
      `SELECT render_id
       FROM idempotency_keys
       WHERE workspace_id = ? AND key = ? AND expires_at > ?
       LIMIT 1`,
    )
    .bind(workspaceId, idempotencyKey, createdAt)
    .first<IdempotencyRow>();

  return row?.render_id ?? renderId;
}

export async function listRenders(db: D1Database, workspaceId: string, limit: number): Promise<RenderRecord[]> {
  const result = await db
    .prepare(
      `SELECT render_id, asset_id, preset, created_at
       FROM renders
       WHERE workspace_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .bind(workspaceId, limit)
    .all<RenderRow>();

  return result.results.map((row) => ({
    render_id: row.render_id,
    asset_id: row.asset_id,
    preset: row.preset,
    created_at: row.created_at,
  }));
}

async function deleteExpiredIdempotencyKeys(db: D1Database, workspaceId: string, now: Date): Promise<void> {
  await db
    .prepare("DELETE FROM idempotency_keys WHERE workspace_id = ? AND expires_at <= ?")
    .bind(workspaceId, now.toISOString())
    .run();
}

interface ApiKeyMap {
  [sha256Hex: string]: string;
}

export async function resolveWorkspaceId(request: Request, env: Env): Promise<string | null> {
  const apiKey = parseBearerToken(request.headers.get("Authorization"));
  if (!apiKey) {
    return null;
  }

  const hashedKey = await sha256Hex(apiKey);
  const apiKeys = loadApiKeyMap(env.API_KEY_HASHES_JSON);
  return apiKeys[hashedKey] ?? null;
}

function parseBearerToken(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function loadApiKeyMap(raw: string | undefined): ApiKeyMap {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const map: ApiKeyMap = {};
    for (const [hash, workspaceId] of Object.entries(parsed)) {
      if (isSha256Hex(hash) && typeof workspaceId === "string" && workspaceId.trim()) {
        map[hash] = workspaceId;
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export const PRESETS = ["1080p", "720p", "480p"] as const;

export type Preset = (typeof PRESETS)[number];

export interface CreateRenderBody {
  asset_id: string;
  preset: Preset;
}

export interface RenderRecord {
  render_id: string;
  asset_id: string;
  preset: Preset;
  created_at: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  retry_after: number;
}

export type ErrorCode =
  | "bad_request"
  | "invalid_json"
  | "method_not_allowed"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "unauthorized"
  | "unsupported_media_type"
  | "internal_error";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: HeadersInit = {},
  ) {
    super(message);
  }
}

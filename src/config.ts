/** Single source of truth for tunable defaults. */

export interface HotaudioConfig {
  /** Base site origin. */
  baseUrl: string;
  /** Listen endpoint path. */
  listenPath: string;
  /** UA sent on page + API requests. */
  userAgent: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Retries for idempotent GETs (page, .hax). Never applied to signed POSTs. */
  maxGetRetries: number;
  /** Base delay for GET retry backoff. */
  retryBaseMs: number;
  /** Cap on follow-up listen calls used to page in segment keys. */
  maxKeyFetches: number;
  /** Self-healing: one fresh-state retry on expiry + one bundle refresh on 401. */
  autoRecovery: boolean;
}

export const DEFAULT_CONFIG: Readonly<HotaudioConfig> = {
  baseUrl: 'https://hotaudio.net',
  listenPath: '/api/v1/audio/listen',
  // NOTE: do not "upgrade" this to a Chrome UA. Cloudflare currently serves a
  // challenge (403) to Chrome UAs on the track page and listen endpoint,
  // while this bare UA gets HTTP 200.
  userAgent: 'Mozilla/5.0',
  timeoutMs: 30_000,
  maxGetRetries: 2,
  retryBaseMs: 500,
  maxKeyFetches: 64,
  autoRecovery: true,
};

export function resolveConfig(overrides: Partial<HotaudioConfig> = {}): HotaudioConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

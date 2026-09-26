/** Track-page fetching and `__ha_state` / nozzle-version extraction. */
import { HotaudioError } from './errors';
import type { HotaudioConfig } from './config';
import { fetchTextWithRetry, type FetchFn } from './http';

const TRACK_URL_RE = /^https?:\/\/(www\.)?hotaudio\.net\/u\//i;
// Tolerates var/let/const and single/double quotes; the page has used `var ... "..."` so far.
const STATE_RE = /(?:var|let|const)\s+__ha_state\s*=\s*["']([^"']+)["']/;
const NOZZLE_RE = /nozzle\.js\?v=([A-Za-z0-9]+)/;

export function assertTrackUrl(url: string): void {
  if (!TRACK_URL_RE.test(url)) {
    throw new HotaudioError(
      'invalid_url',
      `Not a hotaudio track URL: ${url} (expected https://hotaudio.net/u/...)`,
    );
  }
}

export async function fetchTrackPageHtml(
  pageUrl: string,
  config: HotaudioConfig,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  assertTrackUrl(pageUrl);
  try {
    return await fetchTextWithRetry(pageUrl, {
      fetchFn,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxGetRetries,
      headers: { 'User-Agent': config.userAgent },
    });
  } catch (err) {
    if (err instanceof HotaudioError) {
      throw new HotaudioError('page_fetch_failed', `Could not load track page: ${err.message}`, {
        status: err.status,
        retryable: err.retryable,
        cause: err,
      });
    }
    throw new HotaudioError('page_fetch_failed', `Could not load track page: ${String(err)}`, {
      cause: err,
    });
  }
}

export function extractStateBlob(html: string): string {
  const m = html.match(STATE_RE);
  if (!m?.[1]) {
    throw new HotaudioError(
      'state_not_found',
      'Track page has no __ha_state blob (page markup changed?)',
    );
  }
  return m[1];
}

/** Null when the page no longer references the player bundle (markup changed). */
export function extractNozzleVersion(html: string): string | null {
  return html.match(NOZZLE_RE)?.[1] ?? null;
}

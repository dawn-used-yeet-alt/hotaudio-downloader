/** HTTP helpers: timeouts + limited retry for idempotent GETs. */
import { HotaudioError } from './errors';

export type FetchFn = typeof fetch;

export interface RequestOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new HotaudioError('network_failed', `Request timed out after ${timeoutMs}ms: ${url}`, {
        retryable: true,
        cause: err,
      });
    }
    throw new HotaudioError('network_failed', `Request failed: ${url}: ${toMsg(err)}`, {
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

function toMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET with timeout + exponential backoff. Only for idempotent reads
 * (track page, .hax bytes). Signed listen POSTs must NOT use this.
 */
export async function fetchTextWithRetry(
  url: string,
  opts: RequestOptions & { maxRetries?: number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 2;
  let last: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchFn, url, { headers: opts.headers }, timeoutMs);
      if (!res.ok) {
        throw new HotaudioError('network_failed', `GET ${url} returned HTTP ${res.status}`, {
          status: res.status,
          retryable: res.status >= 500 || res.status === 429,
        });
      }
      return await res.text();
    } catch (err) {
      last = err;
      const retryable = err instanceof HotaudioError ? err.retryable : true;
      if (attempt >= maxRetries || !retryable) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Same as above but for binary payloads (.hax container). */
export async function fetchBytesWithRetry(
  url: string,
  opts: RequestOptions & { maxRetries?: number } = {},
): Promise<Uint8Array> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 2;
  let last: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchFn, url, { headers: opts.headers }, timeoutMs);
      if (!res.ok) {
        throw new HotaudioError(
          'hax_download_failed',
          `HAX download returned HTTP ${res.status} for ${url}`,
          { status: res.status, retryable: res.status >= 500 || res.status === 429 },
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      last = err;
      const retryable = err instanceof HotaudioError ? err.retryable : true;
      if (attempt >= maxRetries || !retryable) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Single-shot fetch used for the signed listen POST (no retry by design). */
export async function fetchOnce(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetchWithTimeout(fetchFn, url, init, timeoutMs);
}

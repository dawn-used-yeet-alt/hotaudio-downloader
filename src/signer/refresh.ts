/**
 * Runtime bundle refresh: fetch the live player, patch it, swap it into the
 * sandbox. In-memory only — never writes to disk. Persisting a new bundle
 * still requires the manual `update-nozzle.ts` + live-200 proof (REPAIR.md),
 * because a bundle that signs with the wrong shape is worse than an error.
 */
import { HotaudioError } from '../errors';
import type { HotaudioConfig } from '../config';
import { fetchOnce, type FetchFn } from '../http';
import type { Logger } from '../logger';
import { patchNozzleBundle } from './patch';
import { getLoadedNozzleVersion, refreshSandboxBundle } from './sandbox';
import { SIGNATURE_RE } from './version';

export interface RefreshResult {
  refreshed: boolean;
  version: string;
}

/**
 * Download the live bundle for `version`. Sends browser headers since the
 * CDN serves a challenge page to bare requests.
 */
export async function fetchLiveNozzleBundle(
  version: string,
  config: HotaudioConfig,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const url = `${config.baseUrl}/nozzle.js?v=${version}`;
  let res: Response;
  try {
    res = await fetchOnce(
      fetchFn,
      url,
      { headers: { 'User-Agent': config.userAgent, Referer: `${config.baseUrl}/` } },
      config.timeoutMs,
    );
  } catch (err) {
    throw new HotaudioError('network_failed', `Bundle fetch failed for v${version}`, { cause: err });
  }
  if (!res.ok) {
    throw new HotaudioError('network_failed', `Bundle fetch returned HTTP ${res.status} for v${version}`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const text = await res.text();
  if (/^\s*<!DOCTYPE/i.test(text)) {
    throw new HotaudioError('signer_init_failed', 'Bundle fetch got a challenge page, not JS');
  }
  if (text.length < 1000 || !text.includes('Dt')) {
    throw new HotaudioError('signer_init_failed', 'Downloaded bundle looks wrong');
  }
  return text;
}

/**
 * Try to move the sandbox to `liveVersion`. No-op when already current.
 * Throws on any failure; callers must surface the ORIGINAL listen error.
 */
export async function tryAutoRefreshBundle(
  liveVersion: string | null,
  config: HotaudioConfig,
  fetchFn: FetchFn,
  logger: Logger,
  signProbe: (payload: string) => string,
): Promise<RefreshResult> {
  const current = getLoadedNozzleVersion();
  if (!liveVersion || liveVersion === current) return { refreshed: false, version: current };
  logger.info(`Player moved ${current} -> ${liveVersion}; refreshing signer ...`);
  const raw = await fetchLiveNozzleBundle(liveVersion, config, fetchFn);
  const patched = patchNozzleBundle(raw);
  refreshSandboxBundle(patched, liveVersion);
  // Smoke-test the new theater before trusting it for the real request.
  const probe = signProbe(JSON.stringify({ tid: '123', pid: '456', key: 'test', tick: 'abc', first: -1 }));
  if (!SIGNATURE_RE.test(probe)) {
    throw new HotaudioError('signer_init_failed', `Refreshed bundle signed malformed: ${probe}`);
  }
  logger.info(`Signer refreshed to v${liveVersion} (in-memory; run update-nozzle.ts to persist)`);
  return { refreshed: true, version: liveVersion };
}

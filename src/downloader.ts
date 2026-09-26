/**
 * Download orchestrator. Each step is a small method so failures map to one
 * error code and tests can drive steps in isolation.
 *
 * Self-healing (on by default, `autoRecovery: false` to disable):
 * - `session_expired` -> refetch the page once for a fresh tick, retry once.
 * - `signature_rejected` -> if the page advertises a newer player bundle,
 *   fetch + patch + smoke-test it in memory and retry the listen once.
 * Both are capped at one attempt each: recovery hides transient rot, never
 * retry-loops a real rejection (that gets you rate-limited).
 */
import { HotaudioError } from './errors';
import { DEFAULT_CONFIG, resolveConfig, type HotaudioConfig } from './config';
import { silentLogger, type Logger } from './logger';
import type { FetchFn } from './http';
import { fetchBytesWithRetry } from './http';
import { decryptHotaudioState, hexToBytes, performKeyExchange, type SessionKeys } from './crypto';
import { extractNozzleVersion, extractStateBlob, fetchTrackPageHtml } from './page';
import type { HotaudioState } from './types';
import { parseHax0Header } from './hax/container';
import { KeyRing, decryptSegmentSlice } from './hax/keys';
import { doListen, type ListenRequest } from './listen';
import { signPayload } from './signer/signer';
import { tryAutoRefreshBundle } from './signer/refresh';

export interface HotaudioDownload {
  data: Uint8Array;
  mimeType: 'audio/mp4';
  title: string;
  trackId: string;
  durationSeconds: number;
}

export interface DownloadOptions {
  config?: Partial<HotaudioConfig>;
  fetchFn?: FetchFn;
  logger?: Logger;
  /** Preferred track id; defaults to state.order[0]. */
  trackId?: string;
  onProgress?: (done: number, total: number) => void;
  /** Override config.autoRecovery for one call. */
  autoRecovery?: boolean;
}

/** Seams for tests: fake the network, handshake, or refresh. */
export interface DownloaderDeps {
  fetchPageFn?: typeof fetchTrackPageHtml;
  listenFn?: typeof doListen;
  refreshFn?: typeof tryAutoRefreshBundle;
}

function pickTrackId(
  tracks: Record<string, { key: string; title: string }>,
  order: number[] | undefined,
  preferred?: string,
): string {
  if (preferred && tracks[preferred]) return preferred;
  if (preferred) {
    throw new HotaudioError('state_invalid', `Track ${preferred} not in page state`);
  }
  // Integer-like ids sort numerically under Object.keys(), so respect the
  // page's own ordering instead of taking keys()[0].
  const ordered = (Array.isArray(order) ? order.map(String) : []).filter((id) => tracks[id]);
  return ordered[0] ?? Object.keys(tracks)[0];
}

interface AttemptState {
  html: string;
  state: HotaudioState;
  session: SessionKeys;
  tid: string;
  trackKey: string;
  trackTitle: string;
}

export class HotaudioDownloader {
  readonly config: HotaudioConfig;
  readonly fetchFn: FetchFn;
  readonly logger: Logger;
  private readonly deps: DownloaderDeps;

  constructor(
    opts: { config?: Partial<HotaudioConfig>; fetchFn?: FetchFn; logger?: Logger; deps?: DownloaderDeps } = {},
  ) {
    this.config = resolveConfig(opts.config);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger ?? silentLogger();
    this.deps = opts.deps ?? {};
  }

  async download(
    pageUrl: string,
    opts: Omit<DownloadOptions, 'config' | 'fetchFn' | 'logger'> = {},
  ): Promise<HotaudioDownload> {
    const autoRecovery = opts.autoRecovery ?? this.config.autoRecovery;
    let attempt: AttemptState = await this.loadState(pageUrl, opts.trackId);
    let refetched = false;
    let refreshed = false;

    for (;;) {
      try {
        return await this.attempt(attempt, opts);
      } catch (err) {
        if (!(err instanceof HotaudioError) || !autoRecovery) throw err;
        if (err.code === 'session_expired' && !refetched) {
          refetched = true;
          this.logger.info('Session expired; refetching page state once ...');
          attempt = await this.loadState(pageUrl, opts.trackId);
          continue;
        }
        if (err.code === 'signature_rejected' && !refreshed) {
          refreshed = true;
          const recovered = await this.tryRefresh(attempt.html, err);
          if (recovered) continue;
          throw err;
        }
        throw err;
      }
    }
  }

  private async loadState(pageUrl: string, trackId?: string): Promise<AttemptState> {
    const fetchPage = this.deps.fetchPageFn ?? fetchTrackPageHtml;
    const html = await fetchPage(pageUrl, this.config, this.fetchFn);
    const state = decryptHotaudioState(extractStateBlob(html));
    const tid = pickTrackId(state.tracks, state.order, trackId);
    const track = state.tracks[tid];
    if (!track) throw new HotaudioError('state_invalid', 'Selected track missing from state');
    const session = await performKeyExchange(state.key);
    return { html, state, session, tid, trackKey: track.key, trackTitle: track.title };
  }

  /** One bundle refresh, then retry the same state. False = nothing to try. */
  private async tryRefresh(html: string, original: HotaudioError): Promise<boolean> {
    const live = extractNozzleVersion(html);
    if (!live) {
      this.logger.warn('Signature rejected but page hides the player version; see REPAIR.md');
      return false;
    }
    const refresh = this.deps.refreshFn ?? tryAutoRefreshBundle;
    try {
      const res = await refresh(live, this.config, this.fetchFn, this.logger, (p) => signPayload(p));
      if (!res.refreshed) {
        this.logger.warn(`Signature rejected on current bundle v${res.version}; see REPAIR.md`);
        return false;
      }
      return true;
    } catch (refreshErr) {
      // Never mask the original rejection with a refresh failure.
      this.logger.warn(
        `Bundle refresh failed (${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}); see REPAIR.md`,
      );
      throw original;
    }
  }

  private async attempt(att: AttemptState, opts: { trackId?: string; onProgress?: (d: number, t: number) => void }): Promise<HotaudioDownload> {
    const listenFn = this.deps.listenFn ?? doListen;
    const listen = (first: number): Promise<Awaited<ReturnType<typeof doListen>>> => {
      const req: ListenRequest = {
        tid: att.tid,
        pid: att.state.pid,
        key: att.trackKey,
        tick: att.state.tick,
        first,
      };
      return listenFn(req, att.session, this.config, this.fetchFn);
    };

    let first: Awaited<ReturnType<typeof doListen>>;
    try {
      first = await listen(-1);
    } catch (err) {
      this.logger.error(err instanceof Error ? err.message : String(err));
      throw err instanceof HotaudioError ? err : new HotaudioError('listen_failed', String(err));
    }
    if (!first.url) throw new HotaudioError('listen_failed', 'Listen API returned no .hax url');

    const haxBytes = await this.fetchHax(first.url);
    const hax = parseHax0Header(haxBytes);
    const ring = new KeyRing(first.keys, hexToBytes);

    const slices: Uint8Array[] = [];
    let total = 0;
    let keyFetches = 0;
    for (let i = 0; i < hax.segmentCount; i++) {
      const seg = hax.segments[i];
      const nextOff = i + 1 < hax.segmentCount ? hax.segments[i + 1].offset : hax.fileLength;
      if (nextOff < seg.offset || nextOff > haxBytes.length) {
        throw new HotaudioError('hax_parse_failed', `Segment ${i} slice out of bounds`);
      }
      const slice = haxBytes.subarray(seg.offset, nextOff);
      let key: Uint8Array;
      try {
        key = await ring.derive(hax.segmentCount, i);
      } catch (err) {
        if (!(err instanceof HotaudioError) || err.code !== 'keys_exhausted') throw err;
        if (keyFetches >= this.config.maxKeyFetches) {
          throw new HotaudioError('keys_exhausted', `Still missing keys after ${keyFetches} fetches`);
        }
        this.logger.info(`Fetching keys for segment ${i} (have ${ring.size} branches) ...`);
        const extra = await listen(i);
        const merged = ring.merge(extra.keys, hexToBytes);
        keyFetches++;
        if (merged === 0) throw err;
        key = await ring.derive(hax.segmentCount, i);
      }
      // A corrupt segment must not kill the whole track, but silently
      // dropping audio is worse: fail loudly so callers notice.
      const plain = decryptSegmentSlice(slice, key);
      slices.push(plain);
      total += plain.length;
      opts.onProgress?.(i + 1, hax.segmentCount);
    }

    const assembled = new Uint8Array(total);
    let off = 0;
    for (const s of slices) {
      assembled.set(s, off);
      off += s.length;
    }
    if (assembled.length === 0) throw new HotaudioError('segment_decrypt_failed', 'Assembled audio is empty');
    if (!hasFtyp(assembled)) {
      this.logger.warn('Decrypted audio has no ftyp box — container format may have changed');
    }
    return {
      data: assembled,
      mimeType: 'audio/mp4',
      title: att.trackTitle,
      trackId: att.tid,
      durationSeconds: hax.durationMs / 1000,
    };
  }

  private async fetchHax(url: string): Promise<Uint8Array> {
    try {
      return await fetchBytesWithRetry(url, {
        fetchFn: this.fetchFn,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxGetRetries,
        headers: { 'User-Agent': this.config.userAgent },
      });
    } catch (err) {
      if (err instanceof HotaudioError) throw err;
      throw new HotaudioError('hax_download_failed', `HAX download failed: ${String(err)}`, { cause: err });
    }
  }
}

function hasFtyp(buf: Uint8Array): boolean {
  // Scan first 64 bytes for the ftyp box tag instead of assuming an offset.
  const end = Math.min(buf.length, 64);
  for (let i = 0; i + 4 <= end; i++) {
    if (buf[i] === 0x66 && buf[i + 1] === 0x74 && buf[i + 2] === 0x79 && buf[i + 3] === 0x70) return true;
  }
  return false;
}

/** Backward-compatible functional wrapper. Returns null on failure (logs the cause). */
export async function downloadHotaudioTrack(
  pageUrl: string,
  opts: DownloadOptions = {},
): Promise<HotaudioDownload | null> {
  const dl = new HotaudioDownloader({
    config: opts.config,
    fetchFn: opts.fetchFn,
    logger: opts.logger,
  });
  try {
    return await dl.download(pageUrl, {
      trackId: opts.trackId,
      onProgress: opts.onProgress,
      autoRecovery: opts.autoRecovery,
    });
  } catch (err) {
    if (opts.logger) opts.logger.error(err instanceof Error ? err.message : String(err));
    else console.error('Hotaudio download failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export { DEFAULT_CONFIG };

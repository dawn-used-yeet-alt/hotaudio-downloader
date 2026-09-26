/**
 * Download orchestrator. Each step is a small method so failures map to one
 * error code and tests can drive steps in isolation.
 */
import { HotaudioError } from './errors';
import { DEFAULT_CONFIG, resolveConfig, type HotaudioConfig } from './config';
import { silentLogger, type Logger } from './logger';
import type { FetchFn } from './http';
import { fetchBytesWithRetry } from './http';
import { decryptHotaudioState, hexToBytes, performKeyExchange } from './crypto';
import { extractStateBlob, fetchTrackPageHtml } from './page';
import { parseHax0Header } from './hax/container';
import { KeyRing, decryptSegmentSlice } from './hax/keys';
import { doListen } from './listen';

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

export class HotaudioDownloader {
  readonly config: HotaudioConfig;
  readonly fetchFn: FetchFn;
  readonly logger: Logger;

  constructor(opts: { config?: Partial<HotaudioConfig>; fetchFn?: FetchFn; logger?: Logger } = {}) {
    this.config = resolveConfig(opts.config);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger ?? silentLogger();
  }

  async download(pageUrl: string, opts: Omit<DownloadOptions, 'config' | 'fetchFn' | 'logger'> = {}): Promise<HotaudioDownload> {
    const html = await fetchTrackPageHtml(pageUrl, this.config, this.fetchFn);
    const state = decryptHotaudioState(extractStateBlob(html));
    const tid = pickTrackId(state.tracks, state.order, opts.trackId);
    const track = state.tracks[tid];
    if (!track) throw new HotaudioError('state_invalid', 'Selected track missing from state');

    const session = await performKeyExchange(state.key);
    const listen = (first: number) =>
      doListen({ tid, pid: state.pid, key: track.key, tick: state.tick, first }, session, this.config, this.fetchFn);

    let first: Awaited<ReturnType<typeof listen>>;
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
      title: track.title,
      trackId: tid,
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
    return await dl.download(pageUrl, { trackId: opts.trackId, onProgress: opts.onProgress });
  } catch (err) {
    if (opts.logger) opts.logger.error(err instanceof Error ? err.message : String(err));
    else console.error('Hotaudio download failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export { DEFAULT_CONFIG };

import { describe, it, expect } from 'bun:test';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { HotaudioDownloader } from '../src/downloader';
import { HotaudioError } from '../src/errors';
import { DEFAULT_CONFIG } from '../src/config';
import { silentLogger } from '../src/logger';
import { patchNozzleBundle } from '../src/signer/patch';
import { fetchLiveNozzleBundle, tryAutoRefreshBundle } from '../src/signer/refresh';
import { getLoadedNozzleVersion } from '../src/signer/sandbox';

/** Build page HTML carrying a valid encrypted state blob (offline fixture). */
function makeStateHtml(nozzleVersion: string): string {
  const pub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const pubHex = Buffer.from(pub).toString('hex');
  const state = { pid: '1', tick: 'tick-1', key: pubHex, tracks: { '7': { key: 'k', title: 'T' } } };
  const key32 = new Uint8Array(32).fill(7);
  const ct = chacha20poly1305(key32, new Uint8Array(12)).encrypt(
    new TextEncoder().encode(JSON.stringify(state)),
  );
  const raw = new Uint8Array(ct.length + 32);
  raw.set(ct, 0);
  raw.set(key32, ct.length);
  const b64 = Buffer.from(raw).toString('base64');
  return `<html><script>var __ha_state = "${b64}"</script><script src="/nozzle.js?v=${nozzleVersion}"></script></html>`;
}

describe('patchNozzleBundle', () => {
  it('patches the single Dt=E( point', () => {
    expect(patchNozzleBundle('var a=1;Dt=E(foo);var b=2;')).toBe(
      'var a=1;globalThis.__lastDt=Dt=E(foo);var b=2;',
    );
  });

  it('refuses already-patched bundles', () => {
    expect(() => patchNozzleBundle('globalThis.__lastDt=Dt=E(x)')).toThrow(HotaudioError);
  });

  it('refuses zero or multiple patch points', () => {
    expect(() => patchNozzleBundle('var a=1;')).toThrow(HotaudioError);
    expect(() => patchNozzleBundle('Dt=E(a);Dt=E(b);')).toThrow(HotaudioError);
  });
});

describe('fetchLiveNozzleBundle', () => {
  const config = DEFAULT_CONFIG;

  it('rejects challenge pages and wrong-looking bundles', async () => {
    const html = (async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchLiveNozzleBundle('ABC', config, html)).rejects.toBeInstanceOf(HotaudioError);
    const junk = (async () => new Response('x'.repeat(2000), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchLiveNozzleBundle('ABC', config, junk)).rejects.toBeInstanceOf(HotaudioError);
  });

  it('rejects HTTP errors', async () => {
    const fail = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchLiveNozzleBundle('ABC', config, fail)).rejects.toMatchObject({ code: 'network_failed' });
  });
});

describe('tryAutoRefreshBundle', () => {
  it('is a no-op when already on the live version', async () => {
    let calls = 0;
    const res = await tryAutoRefreshBundle(
      getLoadedNozzleVersion(),
      DEFAULT_CONFIG,
      (async () => {
        calls++;
        return new Response('', { status: 500 });
      }) as unknown as typeof fetch,
      silentLogger(),
      () => '9:' + 'a'.repeat(32),
    );
    expect(res.refreshed).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('downloader auto-recovery', () => {
  const pageUrl = 'https://hotaudio.net/u/some/track';

  it('refetches state once on session_expired, then gives up', async () => {
    let pageCalls = 0;
    let listenCalls = 0;
    const html = makeStateHtml('AAAA');
    const dl = new HotaudioDownloader({
      logger: silentLogger(),
      deps: {
        fetchPageFn: (async () => {
          pageCalls++;
          return html;
        }) as typeof import('../src/page').fetchTrackPageHtml,
        listenFn: (async () => {
          listenCalls++;
          throw HotaudioError.sessionExpired('tick stale');
        }) as typeof import('../src/listen').doListen,
      },
    });
    await expect(dl.download(pageUrl)).rejects.toMatchObject({ code: 'session_expired' });
    expect(pageCalls).toBe(2);
    expect(listenCalls).toBe(2);
  });

  it('does not refetch when autoRecovery is off', async () => {
    let pageCalls = 0;
    const html = makeStateHtml('AAAA');
    const dl = new HotaudioDownloader({
      logger: silentLogger(),
      deps: {
        fetchPageFn: (async () => {
          pageCalls++;
          return html;
        }) as typeof import('../src/page').fetchTrackPageHtml,
        listenFn: (async () => {
          throw HotaudioError.sessionExpired('tick stale');
        }) as typeof import('../src/listen').doListen,
      },
    });
    await expect(dl.download(pageUrl, { autoRecovery: false })).rejects.toMatchObject({
      code: 'session_expired',
    });
    expect(pageCalls).toBe(1);
  });

  it('refreshes the bundle once on signature_rejected, then gives up', async () => {
    let listenCalls = 0;
    let refreshCalls = 0;
    const html = makeStateHtml('NEWVERSION');
    const dl = new HotaudioDownloader({
      logger: silentLogger(),
      deps: {
        fetchPageFn: (async () => html) as typeof import('../src/page').fetchTrackPageHtml,
        listenFn: (async () => {
          listenCalls++;
          throw HotaudioError.badSignature('bad signature');
        }) as typeof import('../src/listen').doListen,
        refreshFn: (async () => {
          refreshCalls++;
          return { refreshed: true, version: 'NEWVERSION' };
        }) as typeof tryAutoRefreshBundle,
      },
    });
    await expect(dl.download(pageUrl)).rejects.toMatchObject({ code: 'signature_rejected' });
    expect(listenCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('surfaces the original rejection when refresh has nothing to do', async () => {
    let listenCalls = 0;
    let refreshCalls = 0;
    const html = makeStateHtml('AAAA');
    const dl = new HotaudioDownloader({
      logger: silentLogger(),
      deps: {
        fetchPageFn: (async () => html) as typeof import('../src/page').fetchTrackPageHtml,
        listenFn: (async () => {
          listenCalls++;
          throw HotaudioError.badSignature('bad signature');
        }) as typeof import('../src/listen').doListen,
        refreshFn: (async () => {
          refreshCalls++;
          return { refreshed: false, version: getLoadedNozzleVersion() };
        }) as typeof tryAutoRefreshBundle,
      },
    });
    await expect(dl.download(pageUrl)).rejects.toMatchObject({ code: 'signature_rejected' });
    expect(listenCalls).toBe(1);
    expect(refreshCalls).toBe(1);
  });
});

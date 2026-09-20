import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decryptHotaudioState, performKeyExchange, sha256, hexToBytes } from './crypto';
import { signHotaudioPayload } from './signer';
import { parseHax0Header, deriveSegmentKey, decryptSegmentSlice } from './hax_decoder';
import type { HotaudioListenResponse } from './types';

const DESKTOP_UA = 'Mozilla/5.0';
// NOTE: do NOT "upgrade" this to a Chrome UA. Cloudflare currently serves a
// `cf-mitigated: challenge` (403) to Chrome UAs on both the track page and
// /api/v1/audio/listen, while the bare `Mozilla/5.0` UA gets HTTP 200.

export interface HotaudioDownload {
  /** Decrypted fragmented-MP4 audio bytes. */
  data: Uint8Array;
  mimeType: 'audio/mp4';
  title: string;
  trackId: string;
  durationSeconds: number;
}

/**
 * Downloads and decrypts a hotaudio track page into raw audio bytes.
 *
 * The whole dance, start to finish: fetch the page, unpack its hidden
 * state, forge the request signature, agree on a secret with their server,
 * ask for the audio file, then decrypt every segment and glue the pieces
 * back together into a playable file.
 *
 * Returns `null` when anything goes sideways (no audio on the page, the
 * server says no, the network flakes). Check the console for the gory
 * details.
 */
export async function downloadHotaudioTrack(pageUrl: string): Promise<HotaudioDownload | null> {
  try {
    // 1. Fetch track page and extract __ha_state
    const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': DESKTOP_UA } });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const stateMatch = html.match(/var __ha_state = "([^"]+)"/);
    if (!stateMatch?.[1]) return null;

    const state = decryptHotaudioState(stateMatch[1]);
    // Prefer the page's own ordering: integer-like track ids sort numerically
    // under Object.keys(), so the first key is NOT necessarily the main
    // track (e.g. order [118346, 14574] yields keys ["14574", "118346"]).
    const orderedIds = Array.isArray((state as any).order)
      ? (state as any).order.map((n: number) => String(n)).filter((id: string) => state.tracks[id])
      : [];
    const tid = orderedIds[0] ?? Object.keys(state.tracks)[0];
    if (!tid || !state.tracks[tid]) return null;

    const track = state.tracks[tid];

    // One session keypair for the whole download. The server derives the
    // session secret from our X-Key header per request and is stateless, so
    // reusing our keypair across handshakes is accepted (verified live) and
    // skips ~15ms of X25519 keygen per follow-up call. The request nonce
    // still comes from hashing each fresh signature, so no nonce ever
    // repeats under the reused secret.
    const session = await performKeyExchange(state.key);

    // One encrypted listen handshake. Each call needs a fresh signature; the
    // tick and session keypair are reusable across calls. Follow-up calls
    // pass first:<segmentIndex> and return extra tree-branch keys (usually
    // without a url); the initial call uses first:-1 and returns the .hax url.
    async function doListen(first: number): Promise<HotaudioListenResponse> {
      const payloadObj = { tid, pid: state.pid, key: track.key, tick: state.tick, first };
      const payloadStr = JSON.stringify(payloadObj);

      // Forge the signature (see signer.ts — here's where the fake
      // browser earns its keep)
      const sig = signHotaudioPayload(payloadStr);

      // Lock the request with the session secret. The nonce comes from
      // hashing our own signature, which is a little cute: the encryption
      // is bound to the exact request we signed.
      const { clientPubHex, Ee } = session;
      const sigBytes = new TextEncoder().encode(sig);
      const sigHash = await sha256(sigBytes);
      const reqNonce = sigHash.subarray(0, 12);

      const payloadBytes = new TextEncoder().encode(payloadStr);
      const cipher = chacha20poly1305(Ee, reqNonce);
      const encBody = cipher.encrypt(payloadBytes);

      // POST /api/v1/audio/listen
      const listenRes = await fetch('https://hotaudio.net/api/v1/audio/listen', {
        method: 'POST',
        headers: {
          'X-Signature': sig,
          'X-Key': clientPubHex,
          'Content-Type': 'application/vnd.hotaudio.crypt+json',
          'User-Agent': DESKTOP_UA,
          Origin: 'https://hotaudio.net',
          Referer: 'https://hotaudio.net/',
        },
        body: encBody,
      });

      if (!listenRes.ok) {
        throw new Error(`Hotaudio listen API returned ${listenRes.status} for first=${first}`);
      }

      // Unwrap their reply. They encrypt it with the same secret but
      // tick the first nonce byte up by one — presumably so a captured
      // request can't be replayed back at us as a fake response.
      const respBuf = new Uint8Array(await listenRes.arrayBuffer());
      const respNonce = new Uint8Array(reqNonce);
      respNonce[0] = (respNonce[0] + 1) & 0xff;

      const decCipher = chacha20poly1305(Ee, respNonce);
      const decRespBytes = decCipher.decrypt(respBuf);
      return JSON.parse(new TextDecoder().decode(decRespBytes)) as HotaudioListenResponse;
    }

    let listenData: HotaudioListenResponse;
    try {
      listenData = await doListen(-1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      return null;
    }
    if (!listenData.url) {
      console.error('Hotaudio listen API returned no .hax url');
      return null;
    }

    // 6. Download .hax file
    const haxRes = await fetch(listenData.url, { headers: { 'User-Agent': DESKTOP_UA } });
    if (!haxRes.ok) return null;
    const haxBytes = new Uint8Array(await haxRes.arrayBuffer());

    // 7. Crack the container: figure out where each segment lives, work
    // out its key, decrypt it. Every segment is independent, so a corrupt
    // one only costs us that slice, not the whole track.
    const hax = parseHax0Header(haxBytes);
    const keysMap: Record<number, Uint8Array> = {};
    for (const [k, v] of Object.entries(listenData.keys)) {
      keysMap[parseInt(k, 10)] = hexToBytes(v);
    }

    const decryptedSlices: Uint8Array[] = [];
    let totalLength = 0;

    for (let i = 0; i < hax.segmentCount; i++) {
      const seg = hax.segments[i];
      const nextOff = i + 1 < hax.segmentCount ? hax.segments[i + 1].offset : hax.fileLength;
      const slice = haxBytes.subarray(seg.offset, nextOff);
      let segKey: Uint8Array;
      try {
        segKey = await deriveSegmentKey(keysMap, hax.segmentCount, i);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith('Key missing in keys map')) throw err;
        // The initial handshake only hands out the first tree-branch key(s).
        // Longer tracks need follow-up handshakes with first:<segmentIndex>
        // to fetch the branch covering segment i (same tick is reusable).
        // Merge the new keys in and retry — each fetch covers a contiguous
        // block, so this runs ~segmentCount/blockSize times, not per segment.
        console.error(`Fetching keys for segment ${i} (have ${Object.keys(keysMap).length} branches) ...`);
        const extra = await doListen(i);
        let merged = 0;
        for (const [k, v] of Object.entries(extra.keys)) {
          const n = parseInt(k, 10);
          if (!keysMap[n]) merged++;
          keysMap[n] = hexToBytes(v);
        }
        if (merged === 0) throw err;
        segKey = await deriveSegmentKey(keysMap, hax.segmentCount, i);
      }
      const plain = decryptSegmentSlice(slice, segKey);
      decryptedSlices.push(plain);
      totalLength += plain.length;
    }

    // 8. Glue the decrypted chunks back together, in order, into one
    // playable fragmented-MP4 file.
    // Assemble fragmented MP4
    const assembled = new Uint8Array(totalLength);
    let offset = 0;
    for (const slice of decryptedSlices) {
      assembled.set(slice, offset);
      offset += slice.length;
    }

    return {
      data: assembled,
      mimeType: 'audio/mp4',
      title: track.title,
      trackId: tid,
      durationSeconds: hax.durationMs / 1000,
    };
  } catch (err) {
    console.error('Hotaudio download failed:', err);
    return null;
  }
}

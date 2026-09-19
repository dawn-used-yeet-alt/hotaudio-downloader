import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decryptHotaudioState, performKeyExchange, sha256, hexToBytes } from './crypto';
import { signHotaudioPayload } from './signer';
import { parseHax0Header, deriveSegmentKey, decryptSegmentSlice } from './hax_decoder';
import type { HotaudioListenResponse } from './types';

const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    const tid = Object.keys(state.tracks)[0];
    if (!tid || !state.tracks[tid]) return null;

    const track = state.tracks[tid];
    const payloadObj = {
      tid,
      pid: state.pid,
      key: track.key,
      tick: state.tick,
      first: -1,
    };
    const payloadStr = JSON.stringify(payloadObj);

    // 2. Forge the signature (see signer.ts — here's where the fake
    // browser earns its keep)
    const sig = signHotaudioPayload(payloadStr);

    // 3. Agree on a secret with their server, then lock the request with it.
    // The nonce comes from hashing our own signature, which is a little
    // cute: the encryption is bound to the exact request we signed.
    const { clientPubHex, Ee } = await performKeyExchange(state.key);
    const sigBytes = new TextEncoder().encode(sig);
    const sigHash = await sha256(sigBytes);
    const reqNonce = sigHash.subarray(0, 12);

    const payloadBytes = new TextEncoder().encode(payloadStr);
    const cipher = chacha20poly1305(Ee, reqNonce);
    const encBody = cipher.encrypt(payloadBytes);

    // 4. POST /api/v1/audio/listen
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
      console.error(`Hotaudio listen API returned ${listenRes.status}`);
      return null;
    }

    // 5. Unwrap their reply. They encrypt it with the same secret but
    // tick the first nonce byte up by one — presumably so a captured
    // request can't be replayed back at us as a fake response.
    const respBuf = new Uint8Array(await listenRes.arrayBuffer());
    const respNonce = new Uint8Array(reqNonce);
    respNonce[0] = (respNonce[0] + 1) & 0xff;

    const decCipher = chacha20poly1305(Ee, respNonce);
    const decRespBytes = decCipher.decrypt(respBuf);
    const listenData = JSON.parse(new TextDecoder().decode(decRespBytes)) as HotaudioListenResponse;

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
      const segKey = await deriveSegmentKey(keysMap, hax.segmentCount, i);
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

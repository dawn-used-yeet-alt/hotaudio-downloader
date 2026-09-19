/**
 * Cracking open the `.hax` container. It's their own little format: a `HAX0`
 * magic stamp, a few lengths, then a bencoded metadata dictionary (yes, the
 * BitTorrent encoding — of all things) describing where each encrypted
 * audio segment lives in the file.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from './crypto';
import type { Hax0Container, Hax0Segment } from './types';

/**
 * A tiny bencode reader — just integers, byte strings, and dicts, which is
 * all the container metadata uses. Nothing fancy, and that's the point.
 */
export function decodeBencode(buf: Uint8Array, offset: number): { value: any; nextOffset: number } {
  const byte = buf[offset];

  // Integer: i<digits>e
  if (byte === 0x69) {
    let end = offset + 1;
    while (buf[end] !== 0x65 && end < buf.length) end++;
    const str = new TextDecoder().decode(buf.subarray(offset + 1, end));
    return { value: parseInt(str, 10), nextOffset: end + 1 };
  }

  // Dictionary: d<key><val>...e
  if (byte === 0x64) {
    let curr = offset + 1;
    const dict: Record<string, any> = {};
    while (buf[curr] !== 0x65 && curr < buf.length) {
      const keyDec = decodeBencode(buf, curr);
      const keyStr = new TextDecoder().decode(keyDec.value);
      curr = keyDec.nextOffset;
      const valDec = decodeBencode(buf, curr);
      dict[keyStr] = valDec.value;
      curr = valDec.nextOffset;
    }
    return { value: dict, nextOffset: curr + 1 };
  }

  // Byte string: <len>:<bytes>
  let colon = offset;
  while (colon < buf.length && buf[colon] >= 0x30 && buf[colon] <= 0x39) colon++;
  if (buf[colon] === 0x3a) {
    const lenStr = new TextDecoder().decode(buf.subarray(offset, colon));
    const len = parseInt(lenStr, 10);
    const start = colon + 1;
    const data = buf.subarray(start, start + len);
    return { value: data, nextOffset: start + len };
  }

  throw new Error(`Unsupported bencode token at offset ${offset}: ${byte}`);
}

/**
 * Reads the 16-byte header plus the metadata dictionary: codec, duration,
 * and the table of (offset, timestamp) pairs for every segment. The
 * `headerLength` field is an absolute offset into the file, not a length —
 * that tripped us up once already.
 */
export function parseHax0Header(buffer: Uint8Array): Hax0Container {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = new TextDecoder().decode(buffer.subarray(0, 4));
  if (magic !== 'HAX0') throw new Error(`Invalid HAX0 magic: ${magic}`);

  const fileLength = view.getUint32(4, true);
  const headerLength = view.getUint32(8, true);
  const extraLength = view.getUint32(12, true);

  const metaDec = decodeBencode(buffer.subarray(16, headerLength), 0);
  const meta = metaDec.value;

  const codec = typeof meta.codec === 'string' ? meta.codec : new TextDecoder().decode(meta.codec);
  const durationMs = meta.durationMs;
  const segmentCount = meta.segmentCount;
  const rawSegments: Uint8Array = meta.segments;

  const segView = new DataView(rawSegments.buffer, rawSegments.byteOffset, rawSegments.byteLength);
  const segments: Hax0Segment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const off = segView.getUint32(i * 8, true);
    const pts = segView.getUint32(i * 8 + 4, true);
    segments.push({ offset: off, pts });
  }

  return {
    fileLength,
    headerLength,
    extraLength,
    baseKey: meta.baseKey,
    codec,
    durationMs,
    segmentCount,
    segments,
  };
}

/**
 * Figures out the decryption key for one segment. The server only hands out
 * a few keys high up in a binary tree, so we find the nearest ancestor we
 * have and hash our way down to the segment, one byte per level. Sounds
 * exotic, but it's just SHA-256 in a loop.
 */
export async function deriveSegmentKey(
  keysMap: Record<number, Uint8Array>,
  segmentCount: number,
  segIdx: number
): Promise<Uint8Array> {
  const bitLen = (segmentCount - 1).toString(2).length;
  const treeBase = 1 + (1 << (bitLen + 1));
  const e = treeBase + segIdx;
  const t = e.toString(2).length - 1;

  let startLevel = -1;
  let currKey: Uint8Array | null = null;

  for (let a = 0; a <= t; a++) {
    const ancestorIdx = e >> (t - a);
    if (keysMap[ancestorIdx]) {
      startLevel = a;
      currKey = keysMap[ancestorIdx];
      break;
    }
  }

  if (!currKey || startLevel === -1) {
    throw new Error(`Key missing in keys map for segment index ${segIdx}`);
  }

  for (let a = startLevel + 1; a <= t; a++) {
    const branchByte = new Uint8Array([(e >> (t - a)) & 0xff]);
    const merged = new Uint8Array(currKey.length + 1);
    merged.set(currKey, 0);
    merged.set(branchByte, currKey.length);
    currKey = await sha256(merged);
  }

  return currKey;
}

/**
 * Decrypts one encrypted segment slice. Same deal as everything else here:
 * ChaCha20-Poly1305 with an all-zero nonce. Decrypt it and you get a chunk
 * of fragmented MP4 — check for the `ftyp` box if you want proof it worked.
 */
export function decryptSegmentSlice(haxSlice: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(haxSlice);
}

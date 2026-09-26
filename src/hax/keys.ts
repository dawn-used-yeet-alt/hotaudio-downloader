/**
 * Segment key derivation: the server hands out a few keys high in a binary
 * tree; find the nearest ancestor we hold and hash down to the segment.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '../crypto';
import { HotaudioError } from '../errors';

export class KeyRing {
  private readonly nodes = new Map<number, Uint8Array>();
  /** Memoized intermediate tree nodes. Cleared whenever new branches merge. */
  private readonly nodeCache = new Map<number, Uint8Array>();

  constructor(initial: Record<string, string> | Record<number, Uint8Array>, fromHex: (h: string) => Uint8Array) {
    this.merge(initial, fromHex);
  }

  get size(): number {
    return this.nodes.size;
  }

  has(node: number): boolean {
    return this.nodes.has(node);
  }

  merge(next: Record<string, string> | Record<number, Uint8Array>, fromHex: (h: string) => Uint8Array): number {
    let added = 0;
    for (const [k, v] of Object.entries(next)) {
      const n = Number.parseInt(k, 10);
      if (!Number.isSafeInteger(n)) continue;
      const bytes = typeof v === 'string' ? fromHex(v) : (v as Uint8Array);
      if (!this.nodes.has(n)) added++;
      this.nodes.set(n, bytes);
    }
    if (added > 0) this.nodeCache.clear();
    return added;
  }

  snapshot(): Record<number, Uint8Array> {
    return Object.fromEntries(this.nodes) as Record<number, Uint8Array>;
  }

  async derive(segmentCount: number, segIdx: number): Promise<Uint8Array> {
    if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= segmentCount) {
      throw new HotaudioError('keys_exhausted', `Segment index ${segIdx} out of range`);
    }
    const bitLen = (segmentCount - 1).toString(2).length;
    const treeBase = 1 + (1 << (bitLen + 1));
    const e = treeBase + segIdx;
    const t = e.toString(2).length - 1;

    let startLevel = -1;
    let curr: Uint8Array | null = null;
    for (let a = 0; a <= t; a++) {
      const ancestor = e >> (t - a);
      const hit = this.nodes.get(ancestor);
      if (hit) {
        startLevel = a;
        curr = hit;
        break;
      }
    }
    if (!curr || startLevel === -1) {
      throw new HotaudioError('keys_exhausted', `Key missing in keys map for segment ${segIdx}`);
    }

    for (let a = startLevel + 1; a <= t; a++) {
      const nodeIdx = e >> (t - a);
      const cached = this.nodeCache.get(nodeIdx);
      if (cached) {
        curr = cached;
        continue;
      }
      const branch = new Uint8Array([(e >> (t - a)) & 0xff]);
      const merged = new Uint8Array(curr.length + 1);
      merged.set(curr, 0);
      merged.set(branch, curr.length);
      curr = await sha256(merged);
      this.nodeCache.set(nodeIdx, curr);
    }
    return curr;
  }
}

/** ChaCha20-Poly1305, all-zero nonce. Returns an fMP4 chunk on success. */
export function decryptSegmentSlice(haxSlice: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new HotaudioError('segment_decrypt_failed', `Segment key must be 32 bytes, got ${key.length}`);
  }
  try {
    return chacha20poly1305(key, new Uint8Array(12)).decrypt(haxSlice);
  } catch (err) {
    throw new HotaudioError('segment_decrypt_failed', 'Segment failed authentication', { cause: err });
  }
}

/**
 * V1-compatible wrapper. Prefer {@link KeyRing} in new code: it owns the
 * node cache lifetime (cleared on merge) instead of leaving that to callers.
 *
 * @deprecated Use KeyRing. Kept so existing tests/scripts keep working.
 */
export async function deriveSegmentKey(
  keysMap: Record<number, Uint8Array>,
  segmentCount: number,
  segIdx: number,
  cache?: Map<number, Uint8Array>,
): Promise<Uint8Array> {
  const bitLen = (segmentCount - 1).toString(2).length;
  const treeBase = 1 + (1 << (bitLen + 1));
  const e = treeBase + segIdx;
  const t = e.toString(2).length - 1;

  let startLevel = -1;
  let curr: Uint8Array | null = null;
  for (let a = 0; a <= t; a++) {
    const ancestor = e >> (t - a);
    if (keysMap[ancestor]) {
      startLevel = a;
      curr = keysMap[ancestor];
      break;
    }
  }
  if (!curr || startLevel === -1) {
    throw new HotaudioError('keys_exhausted', `Key missing in keys map for segment ${segIdx}`);
  }
  for (let a = startLevel + 1; a <= t; a++) {
    const nodeIdx = e >> (t - a);
    const hit = cache?.get(nodeIdx);
    if (hit) {
      curr = hit;
      continue;
    }
    const branch = new Uint8Array([(e >> (t - a)) & 0xff]);
    const merged = new Uint8Array(curr.length + 1);
    merged.set(curr, 0);
    merged.set(branch, curr.length);
    curr = await sha256(merged);
    cache?.set(nodeIdx, curr);
  }
  return curr;
}

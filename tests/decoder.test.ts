import { describe, it, expect } from 'bun:test';
import { deriveSegmentKey, KeyRing } from '../src/hax/keys';
import { decodeBencode } from '../src/hax/bencode';
import { parseHax0Header } from '../src/hax/container';
import { HotaudioError } from '../src/errors';
import { hexToBytes } from '../src/crypto';
import { extractStateBlob, assertTrackUrl } from '../src/page';

describe('HAX0 decoder', () => {
  it('decodes bencode integers, byte strings, and dictionaries', () => {
    const enc = new TextEncoder();
    const data = enc.encode('d5:codec3:aac10:durationMsi3069492e12:segmentCounti3005ee');
    const result = decodeBencode(data, 0);
    expect(result.value).toEqual({
      codec: enc.encode('aac'),
      durationMs: 3069492,
      segmentCount: 3005,
    });
  });

  it('rejects truncated bencode instead of returning garbage', () => {
    expect(() => decodeBencode(new Uint8Array([0x69, 0x31]), 0)).toThrow(HotaudioError);
    expect(() => decodeBencode(new Uint8Array([0xff]), 0)).toThrow(HotaudioError);
  });

  it('derives segment key correctly from root/branch key in keysMap', async () => {
    const rootKeyHex = '5b3201fe002e7ce21ed801e5bd74510253243ce9ef22d6914e6ac3ca475b2f47';
    const rootKeyBytes = new Uint8Array(Buffer.from(rootKeyHex, 'hex'));
    const keysMap: Record<number, Uint8Array> = {
      32: rootKeyBytes,
      64: rootKeyBytes,
    };

    const segmentCount = 3005;
    const key0 = await deriveSegmentKey(keysMap, segmentCount, 0);
    expect(key0.length).toBe(32);

    const key127 = await deriveSegmentKey(keysMap, segmentCount, 127);
    expect(key127.length).toBe(32);
    expect(key127).not.toEqual(key0);
  });

  it('derives identical keys with and without the node-key cache', async () => {
    const rootKeyHex = '5b3201fe002e7ce21ed801e5bd74510253243ce9ef22d6914e6ac3ca475b2f47';
    const rootKeyBytes = new Uint8Array(Buffer.from(rootKeyHex, 'hex'));
    const keysMap: Record<number, Uint8Array> = { 16: rootKeyBytes };
    const cache = new Map<number, Uint8Array>();
    for (let i = 0; i < 127; i++) {
      const plain = await deriveSegmentKey(keysMap, 899, i);
      const cached = await deriveSegmentKey(keysMap, 899, i, cache);
      expect(Buffer.from(cached).toString('hex')).toBe(Buffer.from(plain).toString('hex'));
    }
    expect(cache.size).toBeGreaterThan(0);
  });

  it('KeyRing agrees with the legacy derive function and throws a typed error on gaps', async () => {
    const rootKeyBytes = hexToBytes('5b3201fe002e7ce21ed801e5bd74510253243ce9ef22d6914e6ac3ca475b2f47');
    const ring = new KeyRing({ 16: rootKeyBytes }, hexToBytes);
    const legacy = await deriveSegmentKey({ 16: rootKeyBytes }, 899, 5);
    expect(Buffer.from(await ring.derive(899, 5)).toString('hex')).toBe(
      Buffer.from(legacy).toString('hex'),
    );
    await expect(ring.derive(899, 899)).rejects.toBeInstanceOf(HotaudioError);
    await expect(new KeyRing({}, hexToBytes).derive(899, 0)).rejects.toMatchObject({
      code: 'keys_exhausted',
    });
  });

  it('rejects bad HAX magic and out-of-range offsets', () => {
    const bad = new Uint8Array(32);
    expect(() => parseHax0Header(bad)).toThrow(HotaudioError);
    expect(() => parseHax0Header(new Uint8Array(4))).toThrow(HotaudioError);
  });
});

describe('page helpers', () => {
  it('extracts __ha_state with var/let and single quotes', () => {
    expect(extractStateBlob(`var __ha_state = "abc123"`)).toBe('abc123');
    expect(extractStateBlob(`let __ha_state='xyz'`)).toBe('xyz');
    expect(() => extractStateBlob('<html>no state</html>')).toThrow(HotaudioError);
  });

  it('validates track URLs', () => {
    expect(() => assertTrackUrl('https://hotaudio.net/u/a/b')).not.toThrow();
    expect(() => assertTrackUrl('https://example.com/u/a')).toThrow(HotaudioError);
  });

  it('rejects non-hex keys', () => {
    expect(() => hexToBytes('zz')).toThrow(HotaudioError);
  });
});

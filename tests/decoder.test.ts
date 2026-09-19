import { describe, it, expect } from 'bun:test';
import { deriveSegmentKey, decodeBencode } from '../src/hax_decoder';

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
});

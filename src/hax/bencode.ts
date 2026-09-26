/** Minimal bencode reader: ints, byte strings, dicts. */
import { HotaudioError } from '../errors';

const UTF8 = new TextDecoder();

export type BencodeValue = number | Uint8Array | BencodeDict;
export interface BencodeDict {
  [key: string]: BencodeValue;
}

export function decodeBencode(
  buf: Uint8Array,
  offset = 0,
): { value: BencodeValue; nextOffset: number } {
  if (offset < 0 || offset >= buf.length) {
    throw new HotaudioError('hax_parse_failed', `Bencode offset ${offset} out of bounds`);
  }
  const byte = buf[offset];

  if (byte === 0x69 /* i */) {
    let end = offset + 1;
    while (end < buf.length && buf[end] !== 0x65 /* e */) end++;
    if (end >= buf.length) throw new HotaudioError('hax_parse_failed', 'Unterminated bencode int');
    const n = Number.parseInt(UTF8.decode(buf.subarray(offset + 1, end)), 10);
    if (!Number.isSafeInteger(n)) throw new HotaudioError('hax_parse_failed', 'Bad bencode int');
    return { value: n, nextOffset: end + 1 };
  }

  if (byte === 0x64 /* d */) {
    let curr = offset + 1;
    const dict: Record<string, BencodeValue> = {};
    while (curr < buf.length && buf[curr] !== 0x65 /* e */) {
      const keyDec = decodeBencode(buf, curr);
      if (!(keyDec.value instanceof Uint8Array)) {
        throw new HotaudioError('hax_parse_failed', 'Bencode dict key must be a byte string');
      }
      const keyStr = UTF8.decode(keyDec.value);
      curr = keyDec.nextOffset;
      const valDec = decodeBencode(buf, curr);
      dict[keyStr] = valDec.value;
      curr = valDec.nextOffset;
    }
    if (curr >= buf.length) throw new HotaudioError('hax_parse_failed', 'Unterminated bencode dict');
    return { value: dict, nextOffset: curr + 1 };
  }

  // Byte string <len>:<bytes>
  let colon = offset;
  while (colon < buf.length && buf[colon] >= 0x30 && buf[colon] <= 0x39) colon++;
  if (colon < buf.length && buf[colon] === 0x3a) {
    const len = Number.parseInt(UTF8.decode(buf.subarray(offset, colon)), 10);
    if (!Number.isSafeInteger(len) || len < 0) {
      throw new HotaudioError('hax_parse_failed', 'Bad bencode string length');
    }
    const start = colon + 1;
    if (start + len > buf.length) throw new HotaudioError('hax_parse_failed', 'Bencode overrun');
    return { value: buf.subarray(start, start + len), nextOffset: start + len };
  }

  throw new HotaudioError('hax_parse_failed', `Unsupported bencode token at ${offset}: ${byte}`);
}

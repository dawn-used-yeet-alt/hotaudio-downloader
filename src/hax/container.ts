/** HAX0 container header parsing with bounds checks. */
import { HotaudioError } from '../errors';
import type { Hax0Container, Hax0Segment } from '../types';
import { decodeBencode } from './bencode';

const UTF8 = new TextDecoder();
const HEADER_BYTES = 16;

function bytesToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return UTF8.decode(v);
  throw new HotaudioError('hax_parse_failed', 'HAX metadata field is not a string');
}

export function parseHax0Header(buffer: Uint8Array): Hax0Container {
  if (buffer.length < HEADER_BYTES) {
    throw new HotaudioError('hax_parse_failed', `HAX file too short (${buffer.length} bytes)`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = UTF8.decode(buffer.subarray(0, 4));
  if (magic !== 'HAX0') throw new HotaudioError('hax_parse_failed', `Invalid HAX0 magic: ${magic}`);

  const fileLength = view.getUint32(4, true);
  const headerLength = view.getUint32(8, true);
  const extraLength = view.getUint32(12, true);

  // headerLength is an absolute file offset, not a length.
  if (headerLength < HEADER_BYTES || headerLength > buffer.length) {
    throw new HotaudioError('hax_parse_failed', `Bad HAX headerLength ${headerLength}`);
  }
  if (fileLength < buffer.length) {
    throw new HotaudioError(
      'hax_parse_failed',
      `HAX fileLength ${fileLength} smaller than downloaded ${buffer.length}`,
    );
  }

  const meta = decodeBencode(buffer.subarray(HEADER_BYTES, headerLength), 0).value;
  if (typeof meta !== 'object' || meta === null || meta instanceof Uint8Array) {
    throw new HotaudioError('hax_parse_failed', 'HAX metadata is not a dict');
  }
  const { codec: rawCodec, durationMs, segmentCount, segments: rawSegments, baseKey } = meta as Record<
    string,
    unknown
  >;
  if (typeof durationMs !== 'number' || typeof segmentCount !== 'number') {
    throw new HotaudioError('hax_parse_failed', 'HAX metadata missing duration/segmentCount');
  }
  if (!(rawSegments instanceof Uint8Array) || rawSegments.length < segmentCount * 8) {
    throw new HotaudioError('hax_parse_failed', 'HAX segment table truncated');
  }
  if (!(baseKey instanceof Uint8Array)) {
    throw new HotaudioError('hax_parse_failed', 'HAX metadata missing baseKey');
  }

  const segView = new DataView(rawSegments.buffer, rawSegments.byteOffset, rawSegments.byteLength);
  const segments: Hax0Segment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const off = segView.getUint32(i * 8, true);
    const pts = segView.getUint32(i * 8 + 4, true);
    if (off >= buffer.length) {
      throw new HotaudioError('hax_parse_failed', `Segment ${i} offset ${off} out of bounds`);
    }
    segments.push({ offset: off, pts });
  }
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].offset < segments[i - 1].offset) {
      throw new HotaudioError('hax_parse_failed', 'HAX segment offsets not monotonic');
    }
  }

  return {
    fileLength,
    headerLength,
    extraLength,
    baseKey,
    codec: bytesToString(rawCodec),
    durationMs,
    segmentCount,
    segments,
  };
}

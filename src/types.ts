// Shapes of the things their API hands us. Field names follow their JSON.

export interface HotaudioTrack {
  key: string;
  title: string;
}

export interface HotaudioState {
  pid: string;
  tick: string;
  /** Their X25519 public key, hex-encoded. */
  key: string;
  order?: number[];
  tracks: Record<string, HotaudioTrack>;
}

export interface HotaudioListenResponse {
  /** Where the .hax file lives. */
  url: string;
  length15s: number;
  /** Tree node id -> key, hex-encoded. */
  keys: Record<string, string>;
}

export interface Hax0Segment {
  offset: number;
  pts: number;
}

export interface Hax0Container {
  fileLength: number;
  headerLength: number;
  extraLength: number;
  baseKey: Uint8Array;
  codec: string;
  durationMs: number;
  segmentCount: number;
  segments: Hax0Segment[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isHotaudioState(v: unknown): v is HotaudioState {
  if (!isRecord(v)) return false;
  if (typeof v.pid !== 'string' || typeof v.tick !== 'string' || typeof v.key !== 'string') return false;
  if (!isRecord(v.tracks) || Object.keys(v.tracks).length === 0) return false;
  for (const t of Object.values(v.tracks)) {
    if (!isRecord(t) || typeof t.key !== 'string' || typeof t.title !== 'string') return false;
  }
  if (v.order !== undefined && !Array.isArray(v.order)) return false;
  return true;
}

export function isListenResponse(v: unknown): v is HotaudioListenResponse {
  if (!isRecord(v)) return false;
  if (typeof v.url !== 'string' && v.url !== undefined) return false;
  if (!isRecord(v.keys)) return false;
  return true;
}

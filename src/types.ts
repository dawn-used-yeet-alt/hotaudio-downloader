// Shapes of the things their API hands us. Field names follow their JSON;
// comments are ours, translating what each bit is actually for.

export interface HotaudioTrack {
  key: string;
  title: string;
}

export interface HotaudioState {
  pid: string;
  tick: string;
  key: string; // their X25519 public key, hex-encoded
  order?: number[];
  tracks: Record<string, HotaudioTrack>;
}

export interface HotaudioListenResponse {
  url: string; // where the .hax file lives
  length15s: number;
  keys: Record<string, string>; // tree node id -> key, hex-encoded
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

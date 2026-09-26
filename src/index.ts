// Public API. Import from here; module paths below are internal.
export { HotaudioError, classifyListenFailure } from './errors';
export type { HotaudioErrorCode } from './errors';
export { DEFAULT_CONFIG, resolveConfig } from './config';
export type { HotaudioConfig } from './config';
export { consoleLogger, silentLogger } from './logger';
export type { Logger, LogLevel } from './logger';
export { fetchTextWithRetry, fetchBytesWithRetry } from './http';
export { assertTrackUrl, fetchTrackPageHtml, extractStateBlob, extractNozzleVersion } from './page';
export { hexToBytes, bytesToHex, sha256, decryptHotaudioState, performKeyExchange } from './crypto';
export type { SessionKeys } from './crypto';
export { decodeBencode } from './hax/bencode';
export { parseHax0Header } from './hax/container';
export { KeyRing, decryptSegmentSlice, deriveSegmentKey } from './hax/keys';
export { signHotaudioPayload, signPayload } from './signer/signer';
export { PINNED_NOZZLE_VERSION, PINNED_NOZZLE_URL } from './signer/version';
export { doListen } from './listen';
export { HotaudioDownloader, downloadHotaudioTrack } from './downloader';
export type { HotaudioDownload, DownloadOptions } from './downloader';
export type {
  HotaudioTrack,
  HotaudioState,
  HotaudioListenResponse,
  Hax0Segment,
  Hax0Container,
} from './types';

// Backward-compatible aliases for the V1 layout.
export { decodeBencode as decodeBencodeLegacy } from './hax/bencode';
export { parseHax0Header as parseHax0HeaderLegacy } from './hax/container';
export { decryptSegmentSlice as decryptSegmentSliceLegacy } from './hax/keys';

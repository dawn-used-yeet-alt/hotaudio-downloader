#!/usr/bin/env bun
/** CLI: `bun src/cli.ts <track-url> [-o file.m4a] [--track-id ID] [--verbose]`. */
import { HotaudioDownloader } from './downloader';
import { HotaudioError } from './errors';
import { consoleLogger } from './logger';
import { assertTrackUrl } from './page';

function usage(): never {
  console.error('Usage: bun src/cli.ts <hotaudio-track-url> [-o output.m4a] [--track-id ID] [--verbose]');
  process.exit(2);
}

function sanitize(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'hotaudio-track'
  );
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) usage();
const verbose = args.includes('--verbose') || args.includes('-v');
const url = args.find((a) => !a.startsWith('-') && !a.endsWith('.m4a'));
const outIdx = args.indexOf('-o');
const outFlag = outIdx >= 0 ? args[outIdx + 1] : undefined;
const trackIdx = args.indexOf('--track-id');
const trackId = trackIdx >= 0 ? args[trackIdx + 1] : undefined;

if (!url) usage();
try {
  assertTrackUrl(url);
} catch {
  usage();
}
if (outIdx >= 0 && !outFlag) usage();

const logger = consoleLogger(verbose);
logger.info(`Downloading ${url} ...`);
const dl = new HotaudioDownloader({ logger });
try {
  const result = await dl.download(url, {
    trackId,
    onProgress: verbose ? (d, t) => logger.debug(`segment ${d}/${t}`) : undefined,
  });
  const outPath = outFlag ?? `${sanitize(result.title)} [${result.trackId}].m4a`;
  await Bun.write(outPath, result.data);
  console.log(outPath);
  logger.info(`Saved ${result.data.length} bytes, ${result.durationSeconds.toFixed(0)}s, title: ${result.title}`);
} catch (err) {
  if (err instanceof HotaudioError) {
    logger.error(`${err.code}: ${err.message}`);
    if (err.code === 'signature_rejected') {
      logger.error('See REPAIR.md — the player bundle or env hashes likely need re-capture.');
    }
    if (err.code === 'session_expired') {
      logger.error('Fetch a fresh page and retry once. Do not retry-loop signature failures.');
    }
  } else {
    logger.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

#!/usr/bin/env bun
// The front door: `bun src/cli.ts <track-url> [-o file.m4a]`.
// Thin wrapper around downloadHotaudioTrack — all the real work lives there.
import { downloadHotaudioTrack } from './downloader';

function usage(): never {
  console.error('Usage: bun src/cli.ts <hotaudio-track-url> [-o output.m4a]');
  process.exit(1);
}

function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'hotaudio-track';
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('-') && !a.endsWith('.m4a'));
const outIdx = args.indexOf('-o');
const outFlag = outIdx >= 0 ? args[outIdx + 1] : undefined;

if (!url || !/^https?:\/\/(www\.)?hotaudio\.net\/u\//i.test(url)) usage();

console.error(`Downloading ${url} ...`);
const result = await downloadHotaudioTrack(url);
if (!result) {
  console.error('Download failed (no audio state, bad signature, or network error).');
  process.exit(1);
}

const outPath = outFlag ?? `${sanitize(result.title)} [${result.trackId}].m4a`;
await Bun.write(outPath, result.data);
console.log(outPath);
console.error(
  `Saved ${result.data.length} bytes, ${result.durationSeconds.toFixed(0)}s, title: ${result.title}`
);

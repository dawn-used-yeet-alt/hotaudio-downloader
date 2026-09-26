#!/usr/bin/env bun
// Answer one question: has the site shipped a new player since we last looked?
// Run it like this: bun scripts/check-version.ts <track-page-url>
import {
  fetchTrackPage,
  extractNozzleVersion,
  readPinnedVersion,
  isTrackUrl,
  usageError,
} from './common';

const url = process.argv[2];
if (!isTrackUrl(url)) {
  usageError('check-version.ts', 'give me a track page address.');
}

const saved = readPinnedVersion();

let page: string;
try {
  page = await fetchTrackPage(url);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Could not load the track page: ' + msg);
  process.exit(2);
}

const live = extractNozzleVersion(page);

console.log('Version in our code: ' + (saved || '(not found in src/signer.ts)'));
console.log('Version on the site: ' + (live || '(not found on the page)'));

if (!live) {
  console.error('The page no longer mentions the player file. The page layout may have changed.');
  process.exit(2);
}
if (!saved) {
  console.error('Could not find the saved version in src/signer.ts.');
  process.exit(2);
}
if (live === saved) {
  console.log('Same version. If downloads still fail, the problem is somewhere else.');
  console.log('Try: bun scripts/diagnose.ts ' + url);
} else {
  console.log('Different version. The site shipped a new player, so our copy is old.');
  console.log('Fix it with: bun scripts/update-nozzle.ts ' + url);
  process.exit(1);
}

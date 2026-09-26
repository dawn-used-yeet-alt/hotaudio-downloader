#!/usr/bin/env bun
// Download the newest player file and save it into our code.
// Run it like this:
//   bun scripts/update-nozzle.ts <track-page-url>
//   bun scripts/update-nozzle.ts <track-page-url> --version ABC123
//   bun scripts/update-nozzle.ts <track-page-url> --bundle /tmp/player.js --version ABC123
//
// One thing this cannot do: a few numbers in src/signer.ts and
// src/env_hashes.ts have to be checked by hand afterwards.
// This script prints those steps at the end (they are in REPAIR.md too).
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fetchTrackPage,
  extractNozzleVersion,
  fetchNozzleBundle,
  isTrackUrl,
  REPO_ROOT,
} from './common';

function readOption(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  return process.argv[at + 1];
}

const trackUrl = process.argv[2];
if (!isTrackUrl(trackUrl)) {
  console.error(
    'Usage: bun scripts/update-nozzle.ts <track-page-url> [--version VER] [--bundle /path/player.js]'
  );
  process.exit(2);
}

// Work out which player version we want, and get its code.
let version = readOption('--version');
const bundleFile = readOption('--bundle');
let playerCode: string;

if (bundleFile) {
  playerCode = fs.readFileSync(bundleFile, 'utf8');
  if (!version) {
    const guess = bundleFile.match(/v=([A-Za-z0-9]+)/) || playerCode.match(/v=([A-Za-z0-9]+)/);
    version = guess ? guess[1] : undefined;
  }
  if (!version) {
    console.error('You gave a file but I cannot tell which version it is. Add --version VER too.');
    process.exit(2);
  }
} else {
  if (!version) {
    console.log('Looking up the newest player version ...');
    const page = await fetchTrackPage(trackUrl);
    const live = extractNozzleVersion(page);
    if (!live) {
      console.error('The page no longer mentions the player file. The page layout may have changed.');
      process.exit(1);
    }
    version = live;
  }
  console.log('Downloading player version ' + version + ' ...');
  try {
    playerCode = await fetchNozzleBundle(version);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Download failed: ' + msg);
    process.exit(1);
  }
}

// Basic checks: it should be code, and it should be the fresh (unedited) copy.
if (/^\s*<!DOCTYPE/i.test(playerCode)) {
  console.error('That file is a web page, not player code. Something blocked the download.');
  process.exit(1);
}
if (playerCode.includes('__lastDt')) {
  console.error('That file already has our edit in it. Give me the fresh copy from the site.');
  process.exit(1);
}

// Our code needs a handle to the site's signing function, which lives in a
// line shaped like: Dt=E(
// We add our own copy of that handle: globalThis.__lastDt=Dt=E(
// There should be exactly one such line. Any other count means the site
// reshaped their code and someone has to look at it by hand.
const matches = playerCode.match(/(?<![\w$.])Dt\s*=\s*E\(/g) || [];
if (matches.length !== 1) {
  console.error(
    'Found ' + matches.length + ' places that look like the signing function (expected 1). ' +
      'The site reshaped their code, so fix it by hand (see REPAIR.md step 3).'
  );
  process.exit(1);
}
const edited = playerCode.replace(/(?<![\w$.])Dt\s*=\s*E\(/, 'globalThis.__lastDt=Dt=E(');

// Save the edited player into src/nozzle_raw.ts.
const nozzlePath = path.join(REPO_ROOT, 'src/nozzle_raw.ts');
const header =
  '// Player version ' + version + ', with one small edit (see REPAIR.md step 3).\n' +
  '// The site writes Dt=E(...); we write globalThis.__lastDt=Dt=E(...) so our code can call it.\n';
fs.writeFileSync(nozzlePath, header + 'export const NOZZLE_RAW = ' + JSON.stringify(edited) + ';\n');
console.log('Saved ' + path.relative(REPO_ROOT, nozzlePath) + ' (' + edited.length + ' characters).');

// Point src/signer.ts at the new version.
const signerPath = path.join(REPO_ROOT, 'src/signer.ts');
const signerText = fs.readFileSync(signerPath, 'utf8');
if (!/nozzle\.js\?v=[A-Za-z0-9]+/.test(signerText)) {
  console.error('Could not find the player address in src/signer.ts. Update it by hand.');
  process.exit(1);
}
fs.writeFileSync(
  signerPath,
  signerText.replace(/nozzle\.js\?v=[A-Za-z0-9]+/, 'nozzle.js?v=' + version)
);
console.log('Updated the player address in src/signer.ts to version ' + version + '.');

// Try the new copy once, so a typo shows up now and not later.
const { signHotaudioPayload } = await import('../src/signer.ts');
try {
  const sample = JSON.stringify({ tid: '123', pid: '456', key: 'test', tick: 'abc', first: -1 });
  const sig = signHotaudioPayload(sample);
  if (!/^9:[0-9a-f]{32}$/.test(sig)) {
    throw new Error('unexpected answer shape: ' + sig);
  }
  console.log('Quick check passed: signing runs (made ' + sig + ').');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Quick check FAILED: the new copy does not sign: ' + msg);
  process.exit(1);
}

console.log('');
console.log('Still to do by hand (see REPAIR.md):');
console.log('  1. Check the two stack numbers in src/signer.ts (":2:3472" and ":1:37987").');
console.log('     They belong to this exact player copy, so they may need updating.');
console.log('  2. If downloads still fail, re-capture src/env_hashes.ts.');
console.log('  3. Prove a real download works: bun src/cli.ts ' + trackUrl + ' -o /tmp/check.m4a');
console.log('  4. Only then: bun scripts/update-vector.ts --live-ok');
console.log('  5. Run bun test (all green) and commit everything together.');

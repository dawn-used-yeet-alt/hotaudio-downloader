#!/usr/bin/env bun
// Figure out what broke. It runs three simple checks and tells you what to do next.
// Run it like this: bun scripts/diagnose.ts <track-page-url>
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fetchTrackPage,
  extractNozzleVersion,
  readPinnedVersion,
  isTrackUrl,
  REPO_ROOT,
} from './common';
import { decryptHotaudioState } from '../src/crypto';
import { signHotaudioPayload } from '../src/signer/signer';

const url = process.argv[2];
if (!isTrackUrl(url)) {
  console.error('Usage: bun scripts/diagnose.ts <track-page-url>');
  process.exit(2);
}

console.log('Loading ' + url + ' ...');
let page: string;
try {
  page = await fetchTrackPage(url);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('FAIL: could not load the page: ' + msg);
  process.exit(1);
}

// Check 1: does the page still carry its hidden download info?
const stateMatch = page.match(/var __ha_state = "([^"]+)"/);
if (!stateMatch) {
  console.log('FAIL: the page has no hidden download info. The page layout probably changed.');
  console.log('Next: look at src/crypto.ts and src/downloader.ts (see REPAIR.md).');
  process.exit(1);
}
try {
  const state = decryptHotaudioState(stateMatch[1]);
  const count = Object.keys(state.tracks || {}).length;
  console.log('OK: the hidden download info still opens (' + count + ' track(s)).');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('FAIL: the hidden info is there but will not open: ' + msg);
  console.log('Next: look at src/crypto.ts (see REPAIR.md).');
  process.exit(1);
}

// Check 2: is the site using a newer player than our saved copy?
const saved = readPinnedVersion();
const live = extractNozzleVersion(page);
console.log('Player in our code: ' + (saved || '(missing)') + ', player on the site: ' + (live || '(missing)'));
if (live && saved && live !== saved) {
  console.log('FAIL: the site has a new player, so our saved copy is out of date.');
  console.log('Next: bun scripts/update-nozzle.ts ' + url);
  process.exit(1);
}
if (!live) {
  console.log('Note: the page does not mention the player file. The page layout may have changed.');
}

// Check 3: does our signing code still produce the answer the test expects?
const testFile = fs.readFileSync(path.join(REPO_ROOT, 'tests/signer.test.ts'), 'utf8');
const expectedMatch = testFile.match(/expect\(sig\)\.toBe\('([^']+)'\)/);
const expected = expectedMatch ? expectedMatch[1] : null;
const sampleRequest = JSON.stringify({
  tid: '17343',
  pid: '21031',
  key: 'dvmjckbbc1e9trv2srbgzmwx00',
  tick: '1VmCFHEA7s8l8MuDgHU7D2eHX0Dia',
  first: -1,
});

let made: string;
try {
  made = signHotaudioPayload(sampleRequest, 1787330000);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('FAIL: our signing code crashed: ' + msg);
  process.exit(1);
}

if (made === expected) {
  console.log('OK: signing still works (made ' + made + ').');
  console.log('If downloads still fail with "bad signature", load a fresh page and try once more.');
  console.log('Old pages stop working after about an hour, which looks the same at first.');
  console.log('But do not keep retrying: too many bad tries gets you blocked for a while.');
} else {
  console.log('FAIL: signing gives a different answer than the test expects.');
  console.log('  Our code makes: ' + made);
  console.log('  Test expects:   ' + expected);
  console.log('Do not just edit the test to make it pass. That hides the real problem.');
  console.log('Next: bun scripts/update-nozzle.ts ' + url);
  console.log('Then check the leftovers in REPAIR.md, prove a real download works,');
  console.log('and only then run: bun scripts/update-vector.ts --live-ok');
  process.exit(1);
}

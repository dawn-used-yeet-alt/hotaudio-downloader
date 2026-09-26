#!/usr/bin/env bun
// Save the new expected answer into tests/signer.test.ts.
// Only run this after a real download works with the new player copy.
// Updating the test without that proof just hides the problem.
//
// Run it like this:
//   bun scripts/update-vector.ts <track-page-url>   (checks a real download first)
//   bun scripts/update-vector.ts --live-ok          (you already checked by hand)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTrackUrl, REPO_ROOT } from './common';
import { signHotaudioPayload } from '../src/signer/signer';
import { downloadHotaudioTrack } from '../src/downloader';

// The test always signs this same request, so the answer should always match.
const FROZEN_TIME = 1787330000;
const FROZEN_REQUEST = JSON.stringify({
  tid: '17343',
  pid: '21031',
  key: 'dvmjckbbc1e9trv2srbgzmwx00',
  tick: '1VmCFHEA7s8l8MuDgHU7D2eHX0Dia',
  first: -1,
});

const args = process.argv.slice(2);
const alreadyChecked = args.includes('--live-ok');
const trackUrl = args.find((a) => isTrackUrl(a));

if (trackUrl && !alreadyChecked) {
  // A real download is the only proof the new copy works.
  console.log('Trying a real download of ' + trackUrl + ' ...');
  const done = await downloadHotaudioTrack(trackUrl);
  if (!done) {
    console.error('That download failed, so the signing is still wrong. Do not update the test yet.');
    console.error('Go back to REPAIR.md steps 3-4 (player copy, stack numbers, env_hashes).');
    process.exit(1);
  }
  console.log('Download worked (' + done.data.length + ' bytes). Saving the new answer ...');
} else if (!alreadyChecked) {
  console.error('I will not update the test without proof that downloads work.');
  console.error('Either pass a track address (I will try a download first),');
  console.error('or pass --live-ok if you already proved it by hand.');
  process.exit(2);
}

const answer = signHotaudioPayload(FROZEN_REQUEST, FROZEN_TIME);
const testPath = path.join(REPO_ROOT, 'tests/signer.test.ts');
const testText = fs.readFileSync(testPath, 'utf8');
if (!/expect\(sig\)\.toBe\('[^']+'\)/.test(testText)) {
  console.error('Could not find the expected answer in tests/signer.test.ts. Update it by hand.');
  process.exit(1);
}
fs.writeFileSync(
  testPath,
  testText.replace(/expect\(sig\)\.toBe\('[^']+'\)/, "expect(sig).toBe('" + answer + "')")
);
console.log('Saved the new answer ' + answer + ' into tests/signer.test.ts.');
console.log('Now run: bun test');

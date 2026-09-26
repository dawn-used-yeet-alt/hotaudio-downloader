import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The site only sends real pages to something that looks like a browser,
// so we send a normal browser header with every request.
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

// The folder that holds src/, tests/ and scripts/.
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

// Which player version is saved in our code? Single source of truth is
// src/signer/version.ts (PINNED_NOZZLE_VERSION).
export function readPinnedVersion(): string | null {
  const versionFile = fs.readFileSync(path.join(REPO_ROOT, 'src/signer/version.ts'), 'utf8');
  const found = versionFile.match(/PINNED_NOZZLE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!found) {
    return null;
  }
  return found[1];
}

// Which player version does a track page ask for?
export function extractNozzleVersion(html: string): string | null {
  const found = html.match(/nozzle\.js\?v=([A-Za-z0-9]+)/);
  if (!found) {
    return null;
  }
  return found[1];
}

// Load a track page as text.
export async function fetchTrackPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://hotaudio.net/',
    },
  });
  if (!res.ok) {
    throw new Error('track page fetch failed: HTTP ' + res.status);
  }
  return await res.text();
}

// Load the player file for one version.
export async function fetchNozzleBundle(version: string): Promise<string> {
  const url = 'https://hotaudio.net/nozzle.js?v=' + version;
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://hotaudio.net/',
    },
  });
  if (!res.ok) {
    throw new Error('player file fetch failed: HTTP ' + res.status);
  }
  const text = await res.text();
  // Sometimes the site sends a "prove you are human" page instead of code.
  if (/^\s*<!DOCTYPE/i.test(text)) {
    throw new Error(
      'got a human-check page instead of the player file (blocked request)'
    );
  }
  if (text.length < 1000 || !text.includes('Dt')) {
    throw new Error('downloaded player file looks wrong');
  }
  return text;
}

// True when the text is a track page address.
export function isTrackUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^https?:\/\/(www\.)?hotaudio\.net\/u\//i.test(value);
}

// Print an error plus how to call the script, then quit.
export function usageError(script: string, msg: string): never {
  console.error('Error: ' + msg);
  console.error('Usage: bun scripts/' + script + ' <track-page-url> [options]');
  process.exit(2);
}

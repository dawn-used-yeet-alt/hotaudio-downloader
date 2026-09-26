/**
 * Pinned player bundle identity. Single source of truth — the sandbox, the
 * error fabricator and the repair scripts all read this instead of
 * regex-scraping each other.
 */
export const PINNED_NOZZLE_VERSION = '1J1Db0bF';
export const PINNED_NOZZLE_URL = `https://hotaudio.net/nozzle.js?v=${PINNED_NOZZLE_VERSION}`;

/**
 * Stack-trace constants for the exact patched bundle bytes. The player reads
 * its own stack traces, so these must be re-captured for every new bundle
 * (see REPAIR.md step 3). Kept separate so drift is obvious in review.
 */
export const FAB_STACK_COLUMN = '3472';
export const FAB_STACK_INNER = '37987';

export const SIGNATURE_RE = /^9:[0-9a-f]{32}$/;

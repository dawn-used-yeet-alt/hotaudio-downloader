/** Patch-point for the vendored player bundle (shared by runtime refresh + scripts). */
import { HotaudioError } from '../errors';

const PATCH_RE = /(?<![\w$.])Dt\s*=\s*E\(/g;
const PATCH_RE_SINGLE = /(?<![\w$.])Dt\s*=\s*E\(/;

/** True when the bundle already carries our `__lastDt` export. */
export function isPatchedBundle(code: string): boolean {
  return code.includes('__lastDt');
}

/**
 * Expose the player's internal signature function as `globalThis.__lastDt`.
 * Expects exactly one `Dt=E(` patch point; anything else means the site
 * reshaped their code and a human must look (see REPAIR.md step 3).
 */
export function patchNozzleBundle(raw: string): string {
  if (isPatchedBundle(raw)) {
    throw new HotaudioError('signer_init_failed', 'Bundle already patched (refusing to double-patch)');
  }
  const matches = raw.match(PATCH_RE) ?? [];
  if (matches.length !== 1) {
    throw new HotaudioError(
      'signer_init_failed',
      `Expected 1 Dt=E( patch point, found ${matches.length} (site reshaped their code?)`,
    );
  }
  return raw.replace(PATCH_RE_SINGLE, 'globalThis.__lastDt=Dt=E(');
}

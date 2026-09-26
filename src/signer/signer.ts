/** Public signing API. Thin validation wrapper around the sandbox theater. */
import { HotaudioError } from '../errors';
import { getSandbox } from './sandbox';
import { SIGNATURE_RE } from './version';

export interface SignOptions {
  /** Freeze time (unix seconds). Tests use this for reproducible vectors. */
  timestampSeconds?: number;
}

/** Sign a listen-request payload; returns the `X-Signature` header value. */
export function signHotaudioPayload(payload: string, timestampSeconds?: number): string {
  return signPayload(payload, { timestampSeconds });
}

export function signPayload(payload: string, opts: SignOptions = {}): string {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new HotaudioError('signature_failed', 'Cannot sign an empty payload');
  }
  let dt: (p: string) => string;
  try {
    dt = getSandbox().dt;
  } catch (err) {
    if (err instanceof HotaudioError) throw err;
    throw new HotaudioError('signer_init_failed', 'Signer sandbox failed to start', { cause: err });
  }
  const frozen = opts.timestampSeconds ?? null;
  if (frozen !== null) getSandbox().setFrozenTime(frozen);
  try {
    let sig: string;
    try {
      sig = dt(payload);
    } catch (err) {
      throw new HotaudioError('signature_failed', 'Player signature function threw', { cause: err });
    }
    if (!SIGNATURE_RE.test(sig)) {
      throw new HotaudioError('signature_failed', `Signer produced malformed signature: ${sig}`);
    }
    return sig;
  } finally {
    if (frozen !== null) getSandbox().setFrozenTime(null);
  }
}

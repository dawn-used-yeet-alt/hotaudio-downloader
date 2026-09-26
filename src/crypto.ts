/** ChaCha20-Poly1305 + X25519 plumbing. */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { HotaudioError } from './errors';
import { isHotaudioState, type HotaudioState } from './types';

const HEX_RE = /^[0-9a-fA-F]+$/;

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new HotaudioError('state_invalid', `Invalid hex string (len ${hex.length})`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const hash = await crypto.subtle.digest('SHA-256', copy as ArrayBuffer);
  return new Uint8Array(hash);
}

/**
 * Unpacks the `__ha_state` blob embedded in the track page. Layout: base64 of
 * (chacha20-poly1305 ciphertext .. 32-byte key), encrypted with an all-zero nonce.
 */
export function decryptHotaudioState(stateB64: string): HotaudioState {
  let raw: Uint8Array;
  try {
    const bin = atob(stateB64);
    raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  } catch (err) {
    throw new HotaudioError('state_decrypt_failed', 'State blob is not valid base64', { cause: err });
  }
  if (raw.length <= 32 + 16) {
    throw new HotaudioError('state_decrypt_failed', `State blob too short (${raw.length} bytes)`);
  }
  const key32 = raw.subarray(raw.length - 32);
  const ct = raw.subarray(0, raw.length - 32);
  let jsonStr: string;
  try {
    jsonStr = new TextDecoder().decode(chacha20poly1305(key32, new Uint8Array(12)).decrypt(ct));
  } catch (err) {
    throw new HotaudioError('state_decrypt_failed', 'State blob failed authentication/decrypt', {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new HotaudioError('state_invalid', 'Decrypted state is not valid JSON', { cause: err });
  }
  if (!isHotaudioState(parsed)) {
    throw new HotaudioError('state_invalid', 'Decrypted state has unexpected shape');
  }
  return parsed;
}

export interface SessionKeys {
  clientPubHex: string;
  /** Session secret Ee = SHA-256(x25519(shared)). */
  ee: Uint8Array;
}

/** One X25519 keypair per download; the server side is stateless. */
export async function performKeyExchange(serverPubHex: string): Promise<SessionKeys> {
  let serverPub: Uint8Array;
  try {
    serverPub = hexToBytes(serverPubHex);
  } catch (err) {
    throw new HotaudioError('state_invalid', 'State key is not valid hex', { cause: err });
  }
  if (serverPub.length !== 32) {
    throw new HotaudioError('state_invalid', `State key must be 32 bytes, got ${serverPub.length}`);
  }
  try {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const shared = x25519.getSharedSecret(priv, serverPub);
    return { clientPubHex: bytesToHex(pub), ee: await sha256(shared) };
  } catch (err) {
    throw new HotaudioError('listen_failed', 'Key exchange failed', { cause: err });
  }
}

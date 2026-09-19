/**
 * The boring-but-essential crypto plumbing. Nothing sneaky here — just
 * ChaCha20-Poly1305 for the encrypted blobs and X25519 for agreeing on a
 * secret with their server so nobody in the middle can read the requests.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import type { HotaudioState } from './types';

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const hash = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  return new Uint8Array(hash);
}

/**
 * Unpacks the `__ha_state` blob embedded in the track page. It's base64 with
 * the 32-byte key tacked onto the end, encrypting the rest with an all-zero
 * nonce. (Their key management is... let's say "relaxed". Good for us.)
 */
export function decryptHotaudioState(stateB64: string): HotaudioState {
  const rawStr = atob(stateB64);
  const raw = new Uint8Array(rawStr.length);
  for (let i = 0; i < rawStr.length; i++) raw[i] = rawStr.charCodeAt(i);

  const key32 = raw.subarray(raw.length - 32);
  const ct = raw.subarray(0, raw.length - 32);
  const nonce = new Uint8Array(12);

  const chacha = chacha20poly1305(key32, nonce);
  const decrypted = chacha.decrypt(ct);
  const jsonStr = new TextDecoder().decode(decrypted);
  return JSON.parse(jsonStr) as HotaudioState;
}

/**
 * Generates our side of the key exchange and derives the session key `Ee`
 * (just SHA-256 over the shared secret). Our public key goes up in the
 * `X-Key` header so their server can derive the same secret.
 */
export async function performKeyExchange(serverPubHex: string) {
  const privKey = x25519.utils.randomSecretKey();
  const pubKey = x25519.getPublicKey(privKey);
  const serverPub = hexToBytes(serverPubHex);

  const sharedSecret = x25519.getSharedSecret(privKey, serverPub);
  const Ee = await sha256(sharedSecret);

  return {
    clientPubHex: bytesToHex(pubKey),
    Ee,
  };
}

/** Encrypted listen handshake: sign -> encrypt -> POST -> decrypt. */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { HotaudioError, classifyListenFailure } from './errors';
import type { HotaudioConfig } from './config';
import { fetchOnce, type FetchFn } from './http';
import { sha256, type SessionKeys } from './crypto';
import { signPayload } from './signer/signer';
import { isListenResponse, type HotaudioListenResponse } from './types';

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const CRYPT_MIME = 'application/vnd.hotaudio.crypt+json';

export interface ListenRequest {
  tid: string;
  pid: string;
  key: string;
  tick: string;
  first: number;
}

export async function doListen(
  req: ListenRequest,
  session: SessionKeys,
  config: HotaudioConfig,
  fetchFn: FetchFn = fetch,
): Promise<HotaudioListenResponse> {
  const payloadStr = JSON.stringify(req);
  let sig: string;
  try {
    sig = signPayload(payloadStr);
  } catch (err) {
    if (err instanceof HotaudioError) throw err;
    throw new HotaudioError('signature_failed', 'Signing failed', { cause: err });
  }

  // Bind encryption to the exact request we signed.
  const reqNonce = (await sha256(ENC.encode(sig))).subarray(0, 12);
  const encBody = chacha20poly1305(session.ee, reqNonce).encrypt(ENC.encode(payloadStr));

  let res: Response;
  try {
    res = await fetchOnce(
      fetchFn,
      `${config.baseUrl}${config.listenPath}`,
      {
        method: 'POST',
        headers: {
          'X-Signature': sig,
          'X-Key': session.clientPubHex,
          'Content-Type': CRYPT_MIME,
          'User-Agent': config.userAgent,
          Origin: config.baseUrl,
          Referer: `${config.baseUrl}/`,
        },
        body: encBody,
      },
      config.timeoutMs,
    );
  } catch (err) {
    if (err instanceof HotaudioError) throw err;
    throw new HotaudioError('listen_failed', `Listen request failed: ${String(err)}`, {
      retryable: true,
      cause: err,
    });
  }

  const respBuf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    // Error bodies are plaintext — never feed them to the decryptor.
    throw classifyListenFailure(res.status, DEC.decode(respBuf));
  }

  const respNonce = new Uint8Array(reqNonce);
  respNonce[0] = (respNonce[0] + 1) & 0xff;
  let parsed: unknown;
  try {
    parsed = JSON.parse(DEC.decode(chacha20poly1305(session.ee, respNonce).decrypt(respBuf)));
  } catch (err) {
    throw new HotaudioError('listen_failed', 'Listen response failed decrypt/parse', { cause: err });
  }
  if (!isListenResponse(parsed)) {
    throw new HotaudioError('listen_failed', 'Listen response has unexpected shape');
  }
  return parsed as HotaudioListenResponse;
}

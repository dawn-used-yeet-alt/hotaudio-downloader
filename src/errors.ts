/** Typed errors. Every failure in this project maps to one of these codes. */

export type HotaudioErrorCode =
  | 'invalid_url'
  | 'page_fetch_failed'
  | 'state_not_found'
  | 'state_decrypt_failed'
  | 'state_invalid'
  | 'signer_init_failed'
  | 'signature_failed'
  | 'signature_rejected'
  | 'session_expired'
  | 'listen_failed'
  | 'hax_download_failed'
  | 'hax_parse_failed'
  | 'keys_exhausted'
  | 'segment_decrypt_failed'
  | 'network_failed'
  | 'aborted';

export class HotaudioError extends Error {
  readonly code: HotaudioErrorCode;
  /** HTTP status when the error came from an HTTP response. */
  readonly status?: number;
  /** Whether retrying the same operation could plausibly help. */
  readonly retryable: boolean;
  /** Upstream cause, if any. */
  override readonly cause?: unknown;

  constructor(
    code: HotaudioErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'HotaudioError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Never retry signature rejections: hammering a bad signature gets you rate-limited. */
  static badSignature(detail: string, status = 401): HotaudioError {
    return new HotaudioError('signature_rejected', `Listen API rejected signature: ${detail}`, {
      status,
      retryable: false,
    });
  }

  static sessionExpired(detail: string, status?: number): HotaudioError {
    return new HotaudioError(
      'session_expired',
      `Listen session expired (fetch a fresh page state and retry once): ${detail}`,
      { status, retryable: false },
    );
  }
}

/** Classify a non-200 listen response body without decrypting it. */
export function classifyListenFailure(status: number, bodyText: string): HotaudioError {
  const body = bodyText.slice(0, 500);
  if (status === 401 || /bad signature/i.test(body)) return HotaudioError.badSignature(body, status);
  if (/expir|stale.*tick|invalid.*tick|tick/i.test(body)) return HotaudioError.sessionExpired(body, status);
  return new HotaudioError('listen_failed', `Listen API returned ${status}: ${body}`, {
    status,
    retryable: status >= 500 || status === 429,
  });
}

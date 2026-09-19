/**
 * The signature forge. This is the hacky heart of the whole project.
 *
 * Hotaudio's player JavaScript computes a signature ("Dt") over every listen
 * request, and the signature bakes in a fingerprint of the browser it's
 * running in. So to talk to their API from here, we build a little fake
 * browser out of spare parts — just convincing enough that their code can't
 * tell the difference — and then run their actual signature code inside it.
 *
 * If downloads start failing with "bad signature", this file is suspect
 * number one: they probably changed what their code looks for.
 */
import { ENV_HASHES } from './env_hashes';
import { NOZZLE_RAW } from './nozzle_raw';

type DtFunction = (payload: string) => string;
let cachedDt: DtFunction | null = null;
let frozenTimestamp: number | null = null;

function setupSignerEnvironment(): DtFunction {
  if (cachedDt) return cachedDt;

  const g: any = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});

  // Their code checks that media APIs look like the real native ones, so we
  // hand out stubs that print as "[native code]" when inspected.
  const STUB_STRINGS = new Map<any, string>();
  function nativeFn(name: string) {
    const f = function () {};
    Object.defineProperty(f, 'name', { value: name, configurable: true });
    STUB_STRINGS.set(f, 'function ' + name + '() { [native code] }');
    return f;
  }

  class MediaSource {}
  class SourceBuffer {}
  for (const n of ['isTypeSupported', 'addSourceBuffer', 'removeSourceBuffer', 'endOfStream', 'setLiveSeekableRange', 'clearLiveSeekableRange']) {
    (MediaSource as any)[n] = nativeFn(n);
  }
  for (const n of ['appendBuffer', 'abort', 'remove', 'appendStream']) {
    (SourceBuffer.prototype as any)[n] = nativeFn(n);
  }
  for (const n of ['sourceBuffers', 'activeSourceBuffers', 'onsourceopen', 'onsourceended', 'onsourceclose']) {
    try { Object.defineProperty(MediaSource.prototype, n, { get() { return []; }, configurable: true }); } catch {}
  }
  try { Object.defineProperty(MediaSource.prototype, 'duration', { get() { return 0; }, configurable: true }); } catch {}
  for (const n of ['updateend', 'updatestart', 'update', 'error', 'abort']) {
    try { Object.defineProperty(SourceBuffer.prototype, n, { get() { return null; }, configurable: true }); } catch {}
  }
  STUB_STRINGS.set(MediaSource, 'function MediaSource() { [native code] }');
  STUB_STRINGS.set(SourceBuffer, 'function SourceBuffer() { [native code] }');
  try { Object.defineProperty(MediaSource.prototype, Symbol.toStringTag, { value: 'MediaSource', configurable: true }); } catch {}
  try { Object.defineProperty(SourceBuffer.prototype, Symbol.toStringTag, { value: 'SourceBuffer', configurable: true }); } catch {}

  // Pretend to be Chrome on a normal desktop. Their code peeks at the
  // navigator vendor string and at timing APIs, so we give it the answers
  // a real browser would give.
  const navObj = { vendor: 'Google Inc.' };
  try { Object.defineProperty(navObj, Symbol.toStringTag, { value: 'Navigator', configurable: true }); } catch {}
  const perfObj = {
    now: () => 123456.789,
    get timeOrigin() {
      return frozenTimestamp !== null ? frozenTimestamp * 1000 : 1787330000000;
    },
  };
  try { Object.defineProperty(perfObj, Symbol.toStringTag, { value: 'Performance', configurable: true }); } catch {}
  try { Object.defineProperty(g, Symbol.toStringTag, { value: 'Window', configurable: true }); } catch {}

  // Their code stringifies functions to check for tampering, so we
  // intercept Function.prototype.toString and hand back "native code" for
  // all of our fakes. Yes, this mutates a global. Yes, that's gross. It's
  // the only way to pass the check.
  const __origTS = Function.prototype.toString;
  const patchedTS = function (this: any, ...args: any[]): string {
    const target = this === patchedTS ? args[0] : this;
    if (STUB_STRINGS.has(target)) return STUB_STRINGS.get(target)!;
    return __origTS.apply(this === patchedTS ? args[0] : this, (args.length ? [args[0]] : []) as any);
  };
  Function.prototype.toString = patchedTS as any;
  STUB_STRINGS.set(patchedTS, 'function toString() { [native code] }');

  function smartToString(this: any, ...args: any[]): string {
    const target = this === smartToString ? args[0] : this;
    if (STUB_STRINGS.has(target)) return STUB_STRINGS.get(target)!;
    try { return __origTS.call(target); } catch { return String(target); }
  }
  STUB_STRINGS.set(smartToString, 'function toString() { [native code] }');
  const iframeContentWindow = { Function: { prototype: { toString: smartToString } } };

  // The rest of the fake living room: window, document, storage, and
  // friends. Just enough furniture that nothing comes back undefined.
  // ---- globals ----
  g.window = g;
  g.self = g;
  g.navigator = navObj;
  g.performance = perfObj;
  g.MediaSource = MediaSource;
  g.SourceBuffer = SourceBuffer;
  g.addEventListener = () => {};
  if (!g.atob) g.atob = (s: string) => decodeURIComponent(escape(atob(s)));
  if (!g.btoa) g.btoa = (s: string) => btoa(unescape(encodeURIComponent(s)));
  if (!g.localStorage) g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  if (!g.requestAnimationFrame) g.requestAnimationFrame = () => 0;
  g.document = {
    cookie: '',
    createElement(tag: string) { return { tagName: String(tag).toUpperCase(), contentWindow: iframeContentWindow }; },
    documentElement: { appendChild() {}, removeChild() {} },
    addEventListener() {},
  };

  // Optional time travel, used by tests so signatures are reproducible.
  // When a timestamp is frozen, Date and performance agree with each other,
  // exactly like a real browser would.
  // ---- time monkeypatch ----
  const OrigDate = Date;
  class HookedDate extends OrigDate {
    constructor(...args: any[]) {
      if (args.length === 0 && frozenTimestamp !== null) {
        super(frozenTimestamp * 1000);
      } else {
        super(...(args as [any]));
      }
    }
    static override now() {
      return frozenTimestamp !== null ? frozenTimestamp * 1000 : OrigDate.now();
    }
  }
  STUB_STRINGS.set(HookedDate, 'function Date() { [native code] }');
  g.Date = HookedDate;

  // Their code deliberately throws errors and reads the stack traces to
  // fingerprint the JS engine. Outside a real Chrome those traces look
  // wrong (or the error messages differ), so we translate whatever our
  // engine produces into the V8-flavored version their code expects.
  // ---- error fabricator (V8-style messages/stacks) ----
  const NOZZLE_URL = 'https://hotaudio.net/nozzle.js?v=1J1Db0bF';
  g.__FAB = function (err: any) {
    if (!err || typeof err !== 'object') return err;
    const m = String(err.message || err);
    let v8msg = m;
    const jsc = m.match(/undefined is not an object \(evaluating '([^']*)'\)/);
    if (jsc) {
      const expr = jsc[1];
      const mm = expr.match(/\['([^']*)'\]\s*$/) || expr.match(/\.([A-Za-z_$][\w$]*)\s*$/);
      v8msg = "Cannot read properties of undefined (reading '" + (mm ? mm[1] : 'stack') + "')";
    }
    const col = '3472';
    const v8stack = 'TypeError: ' + v8msg + '\n    at ' + NOZZLE_URL + ':2:' + col + '\n    at S (' + NOZZLE_URL + ':1:37987)';
    return {
      name: 'TypeError',
      message: v8msg,
      get stack() { return v8stack; },
      toString() { return 'TypeError: ' + v8msg; },
    };
  };

  // These 144 numbers are a snapshot of the environment checks their code
  // runs. Get even one of them wrong and the signature comes out slightly
  // off — close enough to look right, but the server rejects it. Ask me how
  // I know. (That's exactly how this broke last time.)
  g.__ENVHASHES = ENV_HASHES;

  // And... action. Run their code in our little theater. If all the props
  // held up, it leaves its signature function behind in __lastDt.
  // Evaluate the patched nozzle code
  (0, eval)(NOZZLE_RAW);

  if (typeof g.__lastDt !== 'function') {
    throw new Error('Failed to expose Dt function from nozzle bundle');
  }

  cachedDt = g.__lastDt;
  return cachedDt!;
}

/**
 * Signs a listen-request payload, producing the `X-Signature` header value.
 * Pass a timestamp (in seconds) to freeze time — that's what the tests do
 * so the signature comes out the same every run. Leave it out for live
 * downloads, where the current time is used.
 */
export function signHotaudioPayload(payload: string, timestampSeconds?: number): string {
  const dt = setupSignerEnvironment();
  if (timestampSeconds !== undefined && timestampSeconds !== null) {
    frozenTimestamp = timestampSeconds;
    try {
      return dt(payload);
    } finally {
      frozenTimestamp = null;
    }
  }
  return dt(payload);
}

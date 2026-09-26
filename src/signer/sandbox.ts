/**
 * The fake browser the player signature code runs inside.
 *
 * The player fingerprints its environment (media stubs, navigator, timing,
 * stack traces, global enumeration hashes) so we give it the Chrome-desktop
 * answers it expects, then evaluate the vendored bundle bytes as-is.
 *
 * Load-bearing quirks (do not "clean up"):
 * - The bundle must be evaluated with `(0, eval)(NOZZLE_RAW)`. Importing it
 *   lets the bundler rewrite helpers, which changes Function.toString output
 *   the player checks.
 * - Overwriting Function.prototype.toString and tagging globals is required
 *   to pass the tamper checks.
 * - Browser experiments and this repo must run the identical patched bytes:
 *   patching shifts stack columns the fabricator constants depend on.
 */
import { ENV_HASHES } from './env_hashes';
import { NOZZLE_RAW } from './nozzle_raw';
import { HotaudioError } from '../errors';
import { FAB_STACK_COLUMN, FAB_STACK_INNER, PINNED_NOZZLE_URL } from './version';

export type DtFunction = (payload: string) => string;

const STATE_KEY = '__lastDt';

interface SandboxHandles {
  dt: DtFunction;
  setFrozenTime: (sec: number | null) => void;
}

let cached: SandboxHandles | null = null;
let origToString: typeof Function.prototype.toString | null = null;

function nativeStub(name: string, store: Map<unknown, string>): () => void {
  const f = function () {};
  Object.defineProperty(f, 'name', { value: name, configurable: true });
  store.set(f, `function ${name}() { [native code] }`);
  return f as () => void;
}

function buildSandbox(): SandboxHandles {
  const g = globalThis as Record<string, unknown> & { [k: symbol]: unknown };
  const stubs = new Map<unknown, string>();
  let frozenSec: number | null = null;

  class MediaSource {}
  class SourceBuffer {}
  for (const n of [
    'isTypeSupported',
    'addSourceBuffer',
    'removeSourceBuffer',
    'endOfStream',
    'setLiveSeekableRange',
    'clearLiveSeekableRange',
  ]) {
    (MediaSource as unknown as Record<string, unknown>)[n] = nativeStub(n, stubs);
  }
  for (const n of ['appendBuffer', 'abort', 'remove', 'appendStream']) {
    ((SourceBuffer.prototype as unknown as Record<string, unknown>))[n] = nativeStub(n, stubs);
  }
  for (const n of ['sourceBuffers', 'activeSourceBuffers', 'onsourceopen', 'onsourceended', 'onsourceclose']) {
    try {
      Object.defineProperty(MediaSource.prototype, n, { get: () => [], configurable: true });
    } catch { /* ignore */ }
  }
  try {
    Object.defineProperty(MediaSource.prototype, 'duration', { get: () => 0, configurable: true });
  } catch { /* ignore */ }

  stubs.set(MediaSource, 'function MediaSource() { [native code] }');
  stubs.set(SourceBuffer, 'function SourceBuffer() { [native code] }');

  const nav = { vendor: 'Google Inc.' };
  const perf = {
    now: () => 123456.789,
    get timeOrigin() {
      return (frozenSec ?? 1787330000) * 1000;
    },
  };
  try {
    Object.defineProperty(g, Symbol.toStringTag, { value: 'Window', configurable: true });
  } catch { /* ignore */ }

  if (!origToString) origToString = Function.prototype.toString;
  const baseToString = origToString;
  const patched = function (this: unknown, ...args: unknown[]): string {
    const target = this === patched ? args[0] : this;
    if (stubs.has(target)) return stubs.get(target) as string;
    return (baseToString as (...a: unknown[]) => string).apply(this === patched ? args[0] : this, args);
  };
  Function.prototype.toString = patched as typeof Function.prototype.toString;
  stubs.set(patched, 'function toString() { [native code] }');

  function smartToString(this: unknown, ...args: unknown[]): string {
    const target = this === smartToString ? args[0] : this;
    if (stubs.has(target)) return stubs.get(target) as string;
    try {
      return baseToString!.call(target);
    } catch {
      return String(target);
    }
  }
  stubs.set(smartToString, 'function toString() { [native code] }');
  const iframeWindow = { Function: { prototype: { toString: smartToString } } };

  g.window = g;
  g.self = g;
  g.navigator = nav;
  g.performance = perf;
  g.MediaSource = MediaSource;
  g.SourceBuffer = SourceBuffer;
  g.addEventListener = () => {};
  if (!g.atob) g.atob = (s: string) => decodeURIComponent(escape(atob(s as string)));
  if (!g.btoa) g.btoa = (s: string) => btoa(unescape(encodeURIComponent(s as string)));
  if (!g.localStorage) {
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  if (!g.requestAnimationFrame) g.requestAnimationFrame = () => 0;
  g.document = {
    cookie: '',
    createElement: (tag: string) => ({
      tagName: String(tag).toUpperCase(),
      contentWindow: iframeWindow,
    }),
    documentElement: { appendChild() {}, removeChild() {} },
    addEventListener() {},
  };

  const OrigDate = Date;
  class HookedDate extends OrigDate {
    constructor(...args: [any?, ...any[]]) {
      if (args.length === 0 && frozenSec !== null) super(frozenSec * 1000);
      else super(...(args as [any]));
    }
    static override now(): number {
      return frozenSec !== null ? frozenSec * 1000 : OrigDate.now();
    }
  }
  stubs.set(HookedDate, 'function Date() { [native code] }');
  g.Date = HookedDate as unknown;

  g.__FAB = (err: unknown) => {
    if (!err || typeof err !== 'object') return err;
    const m = String((err as { message?: unknown }).message ?? err);
    let v8msg = m;
    const jsc = m.match(/undefined is not an object \(evaluating '([^']*)'\)/);
    if (jsc) {
      const expr = jsc[1];
      const mm = expr.match(/\['([^']*)'\]\s*$/) || expr.match(/\.([A-Za-z_$][\w$]*)\s*$/);
      v8msg = `Cannot read properties of undefined (reading '${mm ? mm[1] : 'stack'}')`;
    }
    const stack =
      `TypeError: ${v8msg}\n    at ${PINNED_NOZZLE_URL}:2:${FAB_STACK_COLUMN}` +
      `\n    at S (${PINNED_NOZZLE_URL}:1:${FAB_STACK_INNER})`;
    return {
      name: 'TypeError',
      message: v8msg,
      get stack() {
        return stack;
      },
      toString() {
        return `TypeError: ${v8msg}`;
      },
    };
  };
  g.__ENVHASHES = ENV_HASHES;

  // biome-ignore lint: raw vendor bytes must be eval'd as-is (see header).
  (0, eval)(NOZZLE_RAW);

  const dt = g[STATE_KEY] as unknown;
  if (typeof dt !== 'function') {
    throw new HotaudioError(
      'signer_init_failed',
      'Patched nozzle bundle did not expose __lastDt (patch point moved? see REPAIR.md step 3)',
    );
  }
  return { dt: dt as DtFunction, setFrozenTime: (s) => (frozenSec = s) };
}

/** Initialized once; subsequent calls reuse the same theater. */
export function getSandbox(): SandboxHandles {
  if (!cached) cached = buildSandbox();
  return cached;
}

/** Test-only: drop the cached theater so tests start from a clean eval. */
export function __resetSandboxForTests(): void {
  cached = null;
}

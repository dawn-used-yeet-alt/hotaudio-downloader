# hotaudio-downloader

Downloads tracks from hotaudio.net by re-implementing the site's audio
handshake: fetch the page state, sign the listen request the way the site's
player code would, exchange keys, then download and decrypt the audio
segments.

This is reverse-engineered and unofficial. Hotaudio changes their player code
regularly, and when they do this **will** break — usually with a
`signature_rejected` (`401 bad signature`) from the listen API. Nothing can
make that fully resilient; what this rewrite (V2) does is fail loudly with a
typed error, isolate the fragile part, and make the repair path mechanical.
For personal / archival use. Only download what you have the right to keep.

## Install

```sh
bun install
```

## Download a track

```sh
bun src/cli.ts <hotaudio-track-url> [-o output.m4a] [--track-id ID] [--verbose]
```

Saves a `.m4a` file in the current directory.

## Use it as a library

```ts
import { HotaudioDownloader } from './src/index.ts';

const dl = new HotaudioDownloader();
const track = await dl.download('https://hotaudio.net/u/SomeUser/Some-Title');
await Bun.write('out.m4a', track.data);
```

Errors are typed — catch `HotaudioError` and switch on `.code`:

```ts
import { HotaudioDownloader, HotaudioError } from './src/index.ts';

try {
  await new HotaudioDownloader().download(url);
} catch (err) {
  if (err instanceof HotaudioError && err.code === 'signature_rejected') {
    // Player bundle changed — see REPAIR.md, do NOT retry-loop.
  }
  throw err;
}
```

The old null-returning wrapper is still available for one-liners:

```ts
import { downloadHotaudioTrack } from './src/index.ts';

const track = await downloadHotaudioTrack(url);
if (track) await Bun.write('out.m4a', track.data);
```

## Tests / typecheck

```sh
bun test
bunx tsc --noEmit
```

## When it breaks

It will — run `bun scripts/diagnose.ts <track-url>` for triage, then see
[REPAIR.md](REPAIR.md).

## What V2 changed and why

- **Typed errors, no silent `null`.** `HotaudioDownloader.download()` throws
  `HotaudioError` with a machine-readable `code` (`page_fetch_failed`,
  `state_not_found`, `signature_rejected`, `session_expired`, …) plus
  `retryable` and HTTP `status`. The fragile failure modes (bad signature vs
  expired tick vs network blip) used to look identical; now they don't.
- **Retry discipline.** Idempotent GETs (track page, `.hax`) get timeout +
  exponential backoff. The signed listen POST is never blindly retried —
  instead there are exactly two capped self-heals: one fresh-state refetch on
  `session_expired`, one in-memory bundle refresh on `signature_rejected`
  (only when the page advertises a newer player). Disable with
  `autoRecovery: false` or CLI `--no-auto-recovery`.
- **One config object.** URLs, UA, timeouts, retry counts live in
  `src/config.ts` (`resolveConfig`) instead of being scattered as literals.
- **Injectable fetch + logger.** `HotaudioDownloader` takes `fetchFn` and
  `logger`, so tests and embedders don't touch globals or `console`.
- **Signer isolation.** The fake-browser theater lives in
  `src/signer/sandbox.ts`; `src/signer/signer.ts` only validates
  (`SIGNATURE_RE`) and freezes time for tests. The pinned bundle identity
  (`PINNED_NOZZLE_VERSION`, `FAB_STACK_COLUMN`, …) lives in one place,
  `src/signer/version.ts`, which the repair scripts also read — version drift
  can't hide in a regex anymore.
- **Validated parsing.** State JSON, listen responses, bencode, and the HAX0
  header are shape-checked with bounds checks; truncated containers throw
  `hax_parse_failed` instead of decrypting garbage.
- **Key management.** `KeyRing` owns branch keys and the memoized node cache
  (cleared on merge); the paged key-fetch loop is capped by
  `maxKeyFetches` instead of looping until the server stops answering.

## Layout

- `src/errors.ts`, `src/config.ts`, `src/logger.ts`, `src/http.ts` — foundation.
- `src/page.ts`, `src/state` (in `crypto.ts`), `src/types.ts` — page + validation.
- `src/signer/` — `version.ts` (pinned identity), `sandbox.ts` (fake browser),
  `signer.ts` (public API), `env_hashes.ts`, `nozzle_raw.ts` (vendored bundle).
- `src/crypto.ts` — state decrypt + X25519 key exchange.
- `src/listen.ts` — encrypted listen handshake (sign → encrypt → POST → decrypt).
- `src/hax/` — `bencode.ts`, `container.ts`, `keys.ts` (KeyRing + segment decrypt).
- `src/downloader.ts` — `HotaudioDownloader` orchestrator + legacy wrapper.
- `src/cli.ts` — arg parsing, exit codes, progress.

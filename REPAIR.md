# When it breaks (and it will)

Hotaudio changes their player code regularly. When they do, downloads fail
and the fix is always some variant of: look at what changed on their side,
re-capture it, pin it in the tests. This file is the playbook.

## Quick scripts

Each step below has a script (all take a track page URL). Start with triage:

```sh
bun scripts/diagnose.ts https://hotaudio.net/u/SomeUser/Some-Title
bun scripts/check-version.ts https://hotaudio.net/u/SomeUser/Some-Title
bun scripts/update-nozzle.ts https://hotaudio.net/u/SomeUser/Some-Title
# ... verify a live 200 download, then only:
bun scripts/update-vector.ts --live-ok
```

`update-nozzle.ts` does the mechanical part of steps 2–3 (download, patch,
rewrite, smoke test). The stack columns, env hashes, and test vector still
need the manual verification described below — the scripts refuse to skip it.

## What failure looks like

| Symptom | Most likely cause | Where to fix |
|---|---|---|
| `Hotaudio listen API returned 401`, body says `bad signature` | Their signature code or environment checks changed; our forgery no longer passes | `src/signer/` (`signer.ts`, `sandbox.ts`, `version.ts`, `nozzle_raw.ts`, `env_hashes.ts`) |
| `NO STATE` / no `__ha_state` on the page, or state won't decrypt | Track page markup or state format changed | `src/crypto.ts`, `src/downloader.ts` |
| Listen succeeds but audio decrypts to garbage (no `ftyp` box) | `.hax` container or key-derivation changed | `src/hax/` (`container.ts`, `keys.ts`) |
| Everything works but the test suite fails on the signature vector | The test pins an exact signature — it *should* fail when signing logic changes (see below) | `tests/signer.test.ts` |

Rule of thumb: 401 means the signer is lying badly. Garbage audio means the
container format moved. Both at once means they shipped a big player update
and you're in for the full re-capture.

### First: make sure it's actually broken, not just stale

Not every `401` means the code broke. Listen sessions expire — the `tick`
from the page state only lives ~15–60 minutes — and an expired tick also
comes back as an error. The response bodies differ: `bad signature` means
your signature is wrong (the code broke); anything about expiry means you
just need a fresh page state. So re-fetch the track page once and retry
before touching any code. The CLI already fetches fresh state every run, so
a 401 from the CLI is real breakage — but if you're debugging the library
with a saved state blob from an hour ago, that's on you.

And whatever you do: don't retry-loop signature failures. One retry with
fresh state is diagnostics; hammering a bad signature just gets you
rate-limited.

## Step 1: check whether their player version moved

The track page loads the player as `/nozzle.js?v=<VERSION>`, and
`src/signer/version.ts` pins that version as `PINNED_NOZZLE_VERSION`. Compare them:

```sh
# What the live page loads right now:
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36" \
  -H "Referer: https://hotaudio.net/" \
  "https://hotaudio.net/u/SomeUser/Some-Title" | grep -o 'nozzle\.js[^"]*'
```

If the version differs from `NOZZLE_URL`, they shipped a new bundle and you
need steps 2–4. If it's the same, skip to step 3 (the checks may have changed
without a version bump, or the failure is elsewhere).

## Step 2: download the new player code

Their CDN blocks bare requests, so send browser headers (a missing `Referer`
gets you a Cloudflare challenge page instead of JavaScript):

```sh
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36" \
  -H "Referer: https://hotaudio.net/" --compressed \
  "https://hotaudio.net/nozzle.js?v=<NEW-VERSION>" -o /tmp/live-nozzle.js
head -c 200 /tmp/live-nozzle.js   # should start with JS, not <!DOCTYPE
```

Diff it against the previous bundle to see what actually changed before you
touch anything.

## Step 3: rebuild `src/signer/nozzle_raw.ts`

`src/signer/nozzle_raw.ts` is the live player bundle plus one small patch: where the
original assigns its internal signature function (`Dt=...`), ours also
exposes it as `globalThis.__lastDt` so we can call it. To rebuild:

1. Find the `Dt=` assignment in the fresh bundle.
2. Change it to `globalThis.__lastDt=Dt=...` (same statement, just exported).
3. Embed the result as the `NOZZLE_RAW` string in `src/signer/nozzle_raw.ts`.
4. Update `PINNED_NOZZLE_VERSION` in `src/signer/version.ts` to the new version (or let `update-nozzle.ts` do it), and check the
   hardcoded stack frames in the error fabricator (`:2:3472` and `:1:37987`)
   still match the new bundle — their code reads its own stack traces, so
   stale line numbers produce wrong signatures.

## Step 4: re-capture `src/signer/env_hashes.ts`

Those 144 numbers are a snapshot of the environment checks the player runs
while signing. The patched bundle uses them directly; the *unpatched* player
builds the same map by inspecting its own environment. To re-capture, load
the real track page in desktop Chrome with the fresh unpatched bundle
instrumented — hook the global-enumeration opcode's final assignment loop
with a logger, collect every value it writes, dedupe, and that's your new
set. Write them into `src/signer/env_hashes.ts`.

One mercy: the hash set comes from *Chrome's* global surface, not from the
player file, so it usually survives player updates unchanged. The things
that are file-specific and **must** be re-captured on every new bundle are
the stack-column constants (`:2:3472`, `:1:37987`) and the `Dt=E(` patch
point from step 3. All 144 must match — last time, a single wrong
batch produced signatures that looked right but were rejected.

## Step 5: pin the new ground truth in the tests

`tests/signer.test.ts` asserts an *exact* signature at a frozen timestamp.
That strictness is deliberate: a loose prefix check once masked wrong hashes
for a while. After steps 3–4, the frozen signature will be different. To pin
the new value safely:

1. Sign a **live** payload with the updated code and confirm the listen API
   returns `200` (a real download is the only ground truth that matters).
2. Only then, read off what the code produces at the frozen timestamp and
   update the expected value in the test.
3. Run the suite: `bun test` — 4/4 green before you call it fixed.

Never update the expected vector just to make the test pass. The test exists
to catch exactly this kind of drift; changing the expectation without a live
`200` is hiding the problem.

Useful debugging fact: signing is deterministic for a given
`(payload, timestamp)` — the timestamp bytes are taken at call time, so two
calls in the same second agree. If two runs with the same frozen timestamp
disagree, something in the sandbox changed, not the server.

## Detours that look tempting but aren't

Lessons from the original reverse-engineering, kept here so nobody
re-learns them the hard way:

- **Don't "clean up" the `(0, eval)(NOZZLE_RAW)` into an import.** Bun's ESM
  pipeline transpiles imports (rewriting helpers, private fields, etc.),
  which changes what `Function.prototype.toString` returns — and their code
  checks exactly that. The raw bytes must be evaluated as-is.
- **Don't remove the global mutation.** Overwriting
  `Function.prototype.toString` and tagging `globalThis` look like sins
  against good hygiene, and they are — but they're load-bearing. The
  signature reads them.
- **Run the same patched file everywhere.** Patching shifts column offsets
  in any stack trace the code captures, so the fabricator constants are only
  valid for the exact patched bytes they were captured from. Browser
  experiments and this repo must use the identical file.
- **Only decrypt listen responses on HTTP 200.** Error bodies (`bad
  signature`, expiry notices) are plaintext — feeding them to the decryptor
  just produces a confusing second error.
- **Don't reach for `node:crypto` for ChaCha20-Poly1305.** Bun's build
  doesn't implement that cipher (`ERR_CRYPTO_UNKNOWN_CIPHER`). That's why
  this repo uses `@noble/ciphers`.

## Step 6: verify end to end

```sh
bun test
bun src/cli.ts https://hotaudio.net/u/SomeUser/Some-Title -o /tmp/check.m4a
```

If the CLI saves a playable file, you're done. Commit the updated bundle,
hashes, constants, and test vector together — they only make sense as a set.

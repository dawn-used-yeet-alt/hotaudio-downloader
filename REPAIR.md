# When it breaks (and it will)

Hotaudio changes their player code regularly. When they do, downloads fail
and the fix is always some variant of: look at what changed on their side,
re-capture it, pin it in the tests. This file is the playbook.

## What failure looks like

| Symptom | Most likely cause | Where to fix |
|---|---|---|
| `Hotaudio listen API returned 401`, body says `bad signature` | Their signature code or environment checks changed; our forgery no longer passes | `src/signer.ts`, `src/nozzle_raw.ts`, `src/env_hashes.ts` |
| `NO STATE` / no `__ha_state` on the page, or state won't decrypt | Track page markup or state format changed | `src/crypto.ts`, `src/downloader.ts` |
| Listen succeeds but audio decrypts to garbage (no `ftyp` box) | `.hax` container or key-derivation changed | `src/hax_decoder.ts` |
| Everything works but the test suite fails on the signature vector | The test pins an exact signature — it *should* fail when signing logic changes (see below) | `tests/signer.test.ts` |

Rule of thumb: 401 means the signer is lying badly. Garbage audio means the
container format moved. Both at once means they shipped a big player update
and you're in for the full re-capture.

## Step 1: check whether their player version moved

The track page loads the player as `/nozzle.js?v=<VERSION>`, and
`src/signer.ts` hardcodes that version in `NOZZLE_URL`. Compare them:

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

## Step 3: rebuild `src/nozzle_raw.ts`

`src/nozzle_raw.ts` is the live player bundle plus one small patch: where the
original assigns its internal signature function (`Dt=...`), ours also
exposes it as `globalThis.__lastDt` so we can call it. To rebuild:

1. Find the `Dt=` assignment in the fresh bundle.
2. Change it to `globalThis.__lastDt=Dt=...` (same statement, just exported).
3. Embed the result as the `NOZZLE_RAW` string in `src/nozzle_raw.ts`.
4. Update `NOZZLE_URL` in `src/signer.ts` to the new version, and check the
   hardcoded stack frames in the error fabricator (`:2:3472` and `:1:37987`)
   still match the new bundle — their code reads its own stack traces, so
   stale line numbers produce wrong signatures.

## Step 4: re-capture `src/env_hashes.ts`

Those 144 numbers are a snapshot of the environment checks the player runs
while signing. The patched bundle uses them directly; the *unpatched* player
builds the same map by inspecting its own environment. To re-capture, run
the fresh unpatched bundle in a real desktop Chrome (it will enumerate its
environment by itself), dump the keys of the map it builds, and write them
into `src/env_hashes.ts`. All 144 must match — last time, a single wrong
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

## Step 6: verify end to end

```sh
bun test
bun src/cli.ts https://hotaudio.net/u/SomeUser/Some-Title -o /tmp/check.m4a
```

If the CLI saves a playable file, you're done. Commit the updated bundle,
hashes, constants, and test vector together — they only make sense as a set.

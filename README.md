# hotaudio-downloader

A very hacky little tool that downloads tracks from hotaudio.net. It works by
re-implementing the site's own audio handshake: grab the page state, compute
the request signature the site's JavaScript would compute, do the key
exchange, then download and decrypt the audio segments.

Fair warning: this is reverse-engineered, unofficial, and held together with
shims and prayers. Hotaudio changes their player code fairly often, and when
they do, this **will** break — usually with a `401 bad signature` from the
listen API. If that happens, the bundled player logic in `src/nozzle_raw.ts`
and the environment fingerprints in `src/env_hashes.ts` probably need to be
re-captured from the live site. Don't rely on this for anything important.

For personal / archival use. Only download stuff you have the right to keep.

## Install

```sh
bun install
```

## Download a track

```sh
bun src/cli.ts <hotaudio-track-url> [-o output.m4a]
```

Example:

```sh
bun src/cli.ts https://hotaudio.net/u/SomeUser/Some-Title
```

Saves a `.m4a` file in the current directory.

## Use it as a library

```ts
import { downloadHotaudioTrack } from './src/index.ts';

const track = await downloadHotaudioTrack('https://hotaudio.net/u/SomeUser/Some-Title');
if (track) await Bun.write('out.m4a', track.data);
```

`src/index.ts` also exports the lower-level pieces (`signHotaudioPayload`,
`decryptHotaudioState`, `parseHax0Header`, …) if you want to poke at the
protocol yourself.

## Tests

```sh
bun test
```

## When it breaks

It will — run `bun scripts/diagnose.ts <track-url>` for triage, then see
[REPAIR.md](REPAIR.md), the playbook for diagnosing what
hotaudio changed and re-capturing the signature logic, environment hashes,
and test vector.

## Layout

- `src/signer.ts`, `src/env_hashes.ts`, `src/nozzle_raw.ts` — the request
  signature logic (the fragile part).
- `src/crypto.ts` — state decryption and key exchange.
- `src/hax_decoder.ts` — the `.hax` container parser and segment decryption.
- `src/downloader.ts` — ties it all together into `downloadHotaudioTrack()`.
- `src/cli.ts` — the command-line downloader.

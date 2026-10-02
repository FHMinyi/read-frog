# Anki v1 verification

Verified on 2026-10-02 against upstream/fork base `308a08d73091300c14fe2bf184d59895478174ef`.

## Automated checks

- Full Vitest suite: passed with `SKIP_FREE_API=true` and `--maxWorkers=4`
- Type-aware type check and lint: passed
- Repository formatting check and `git diff --check`: passed
- Chrome MV3 unpacked build: passed with `WXT_SKIP_ENV_VALIDATION=true` (local build; production OAuth/analytics configuration is not validated)
- Unit/integration coverage includes original-source validation, safe rendering, conservative lemma identity, exact duplicates, new-sentence append, setup-before-sync, durable IndexedDB close/reopen, worker interruption, lost responses, scheduling-safe API calls, mid-sync revisions, media cache/export, bounded retries, restored local connectivity, and conflicting model/template rejection
- UI/jsdom coverage includes no account dependency, repeated clicks, result/source changes, generation snapshots, pending/error/synced statuses, settings, deck selection and deterministic CET labels
- Default test runs deliberately skip live translation and opt-in network/Anki tests

The environment used Node 26.10.0 installed through the repository runtime declaration and pnpm 11.19.0. The repository continues to declare pnpm 12.6.0; its frozen lockfile installed successfully without dependency-version changes other than adding `fake-indexeddb` as a test-only dependency.

## Real Microsoft speech requests

The existing Read Frog Edge TTS implementation was called with fixed synthetic fixtures (`blossom` and `The blossoms are beautiful.`). Both requests returned real MP3 bytes. `ffprobe` identified 24 kHz mono MP3, and `ffmpeg` decoded the complete files without errors. No private user text or new speech-service credentials were used.

To opt into the same speech test:

```
RUN_LIVE_ANKI_TTS=true pnpm exec vitest run src/utils/anki/__tests__/edge-tts.live.test.ts
```

## Real desktop Anki integration

Official Anki **26.09.3** (official `aqt`/`anki` 26.9.3 Python wheels) ran using its standard Qt offscreen platform. Official AnkiConnect **API v6**, source revision `de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e`, used its default localhost binding and unchanged origin rules. A synthetic extension-origin HTTP request passed CORS without adding a wildcard or changing persistent permissions.

A fresh, isolated **ReadFrogTest** profile was used; no account or personal collection was involved. The production `createAnkiEngine`, `createAnkiClient`, and existing Edge TTS implementation ran against that real local service. Only the extension-side IndexedDB provider was replaced by `fake-indexeddb` for this Node test; its persistence behavior is tested separately.

The production-engine live test passed:

1. Queue a synthetic word before initial setup, then configure the desired test deck
2. Generate and import three real MP3 files: word plus two original sentences
3. Create exactly one note and one card
4. Answer the card through Anki's scheduler, creating an actual review-history record
5. Append the second sentence through `updateNoteFields`
6. Verify unchanged card/note IDs, deck, due date, interval, ease, review count, lapses, queue/type and complete review history
7. Re-save the original capture and verify no duplicate sentence/note
8. Retrieve every stored MP3 and compare every byte with the extension cache; decode the resulting files successfully

The live run preserved: due **5**, interval **5**, ease factor **2500**, repetitions **1**, lapses **0**. All three MP3 files round-tripped exactly (11,232; 14,688; and 16,272 bytes).

For an opt-in rerun, first create a fresh disposable Anki profile named **ReadFrogTest**, install AnkiConnect, and keep it running on `127.0.0.1:8765`:

```
RUN_LIVE_ANKI_CONNECT=true pnpm exec vitest run src/utils/anki/__tests__/anki-connect.live.test.ts
```

This test deliberately refuses the wrong profile or an existing sample-word key. It creates and reviews synthetic cards and leaves them in that isolated profile for inspection. Do not run it against a personal collection.

Official sources: [Anki Linux installation](https://docs.ankiweb.net/platform/linux/installing.html), [official Python-wheel instructions](https://betas.ankiweb.net/#via-pypipip), [aqt 26.9.3](https://pypi.org/project/aqt/26.9.3/), [AnkiConnect marketplace](https://ankiweb.net/shared/info/2055492159), [official repository](https://git.sr.ht/~foosoft/anki-connect).

## Not yet verified

- Complete browser UI click → content script → running service worker → real Anki workflow
- AnkiWeb/AnkiDroid/AnkiMobile collection-and-media synchronization, followed by actual offline playback on a phone
- Cross-browser runtime behavior, especially Firefox/Edge
- A public release with production configuration or redistribution clearance for the existing proprietary layout-engine dependency

A newly spawned Chromium test process was blocked by the cloud sandbox's Unix-socket restriction. The existing cloud browser could open ordinary websites, but its automated extension-management navigation and localhost preview were blocked. These restrictions were not bypassed. Browser-unit tests and builds are not represented as a browser E2E pass.

See [setup and limitations](ANKI.md), including the single-active-exporter restriction and the existing layout-engine license concern.

# Read Frog → Anki (desktop, v1)

This fork saves dictionary results directly to a local AnkiConnect endpoint. No Read Frog account is required to queue or sync cards. Dictionary generation still uses your configured AI provider; its normal account/API requirements are unchanged.

## First-time setup

### Install this fork

The local handoff is a production build loaded as an unpacked extension. It runs without a development server, even though Chrome/Edge require their **Developer mode** switch to load it. This installation switch is separate from the extension's build mode.

For a fresh installation from source, install the repository's Node.js/pnpm versions and run:

```sh
pnpm install --frozen-lockfile
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

In Chrome (`chrome://extensions`) or Edge (`edge://extensions`), enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3` inside this checkout (the folder containing `manifest.json`). Keep that folder in a stable location. Configure an AI provider in the extension for dictionary/translation requests; skipping build-time environment validation does not configure a provider or guarantee hosted-account features.

Existing local-handoff users should continue using their configured `handoff/chrome-mv3` directory and identity; see [local handoff setup](LOCAL-HANDOFF.md). After replacing a build, reload the existing extension and refresh open webpages. A Git pull or push alone does not update an installed extension. Avoid uninstalling to update, since uninstalling can delete extension settings and queued cards.

`pnpm dev` is the development workflow with a running WXT development server. `pnpm build` and `pnpm build:local` produce builds for use without that server. Publishing a GitHub Release or browser-store package is a separate step: this fork's push workflow runs checks, while automatic release packaging is restricted to the upstream repository. The official store extension is a separate distribution and does not acquire this fork's changes from a push here.

### Configure Anki

Use a separate browser profile for the first end-to-end test. Do not run the official Read Frog extension and this fork on the same page at the same time, as their content scripts can interfere. Loading the unpacked build keeps the upstream extension permissions; review those permissions before enabling it.

1. Install desktop [Anki](https://apps.ankiweb.net/) and [AnkiConnect](https://ankiweb.net/shared/info/2055492159) from their official sources. Keep Anki running while exporting. Use a separate test profile first, with no personal collection.
2. In the extension, open **Options → Anki**. The default local endpoint is `http://127.0.0.1:8765`. Only loopback addresses are accepted. V1 does not support remote endpoints or API-key authentication.
3. Load the deck list, select your target deck (or type a new deck name), and choose Save & enable sync. The default English voice is `en-US-AriaNeural`. These settings persist locally.
4. Run the built-in Dictionary on a word or phrase inside its original sentence, then choose **Save to Anki**. A save is acknowledged after local persistence. The options page shows pending, syncing, error, or synced status; error messages and Retry are available there.

The extension never enables AnkiConnect permissions automatically. If AnkiConnect refuses access, review its configuration and allow only your extension's exact origin if needed; do not expose its port publicly or use a wildcard origin. If your AnkiConnect requires an API key, this version deliberately does not ask you to paste that credential into extension settings.

## Card behavior

- One note with one card per confidently resolved word or phrase identity; new sentences append to that note
- Front: collected original sentences only, with their actual target forms highlighted
- Back: each highlighted original sentence with its contextual definition/translation, lemma, available phonetics/POS, CET4/CET6 reference labels, sources, word audio and sentence audio
- The AI proposes a lemma in context; pinned lexical inflection data checks the relationship. Derivations such as `decide` and `decision` stay separate. Ambiguous or unverified identities stay sentence-scoped rather than being merged incorrectly
- Repeated word/phrase + original sentence does not append another example. Additional highlights can be added to the same example
- Updates change note fields, not card scheduling, review history, or deck placement. Changing the default deck applies to new notes; existing notes remain in their existing decks
- A dedicated `Read Frog Context v1` note type keeps a stable key and portable data. Do not rename/delete its fields. The extension rejects conflicting/duplicate note identities rather than guessing

Contiguous phrases stay whole: `locking in` can resolve to `lock in`, and phrase keys remain separate from component-word keys. Only verified head inflections with unchanged tails merge. The separated forms currently supported are `walk through` and `lock in` with exactly one object/reflexive pronoun, such as `walked me through` or `lock it in`. Only the two target spans are highlighted; the inserted pronoun and complete source sentence stay intact. Unsupported or longer gaps, cross-sentence/line matches, and ambiguous candidates are rejected. Phrase CET labels require exact membership of the whole phrase.

The built-in Dictionary requests phonetics for the returned canonical Term, rather than the selected inflected form; unknown pronunciation stays empty. Edited custom Dictionary prompts remain under user control.

Existing notes with the original default `{{Back}}` answer template are upgraded to reuse their highlighted Front sentences on the answer. Custom fields/templates are rejected rather than overwritten. This update does not rewrite existing notes or reset scheduling.

## Queue, audio, and privacy

The queue and audio cache live in the extension's IndexedDB. They survive ordinary browser/service-worker restarts, but not extension removal, browser-profile deletion, or clearing extension data. Export/sync important material to Anki regularly; this queue is not a substitute for collection backups.

While the browser extension is running, a one-minute alarm retries due work with backoff. Anki can be closed when you collect words. Nothing can run while the browser is fully closed; the queue resumes when the extension starts again. A failed audio request keeps the note pending/error until it can be retried; there is no silent text-only export or system-speech fallback.

The existing built-in Edge TTS implementation sends the word and original sentence to Microsoft's online speech service to create MP3 files. That consumer-style endpoint is not an availability-guaranteed public API and can fail or change. Word audio is cached by exact text, voice, provider, and format. The extension copies real MP3 bytes into Anki's media collection before marking a note synced. It never puts temporary URLs or machine-local file paths on cards.

For strict append preservation, use one active desktop exporter per Anki collection. Portable note data supports sequential use from another installation, but AnkiConnect does not provide atomic compare-and-swap for two computers updating the same note simultaneously.

For phone review, use Anki's normal collection **and media** sync, then wait until the phone finishes downloading media before going offline. MP3 and the plain HTML/CSS template are intended to work with AnkiDroid/AnkiMobile. V1 does not create cards from mobile webpages and does not manage AnkiWeb login or synchronization.

## Vocabulary provenance and licensing

CET labels mean exact membership in a pinned, community-maintained ECDICT reference list. They are not official exam coverage, a ranking, or an AI estimate. Both labels can occur; no match stays empty and does not mean “advanced.” See [data provenance](../src/utils/anki/data/README.md) and the bundled `public/licenses/anki-ecdict.txt` for the MIT license, pinned revision, transformations, limitations, counts, and reproducible checksums.

The new Anki card renderer uses its own escaped HTML/CSS and does not use `@read-frog/layout-engine`. The existing extension still depends on that package, whose 0.2.0 license is proprietary and restricts use/distribution to unmodified Read Frog products as distributed by its owner or written permission. This feature does not replace that dependency or establish permission to redistribute the entire fork. Review the package's [published license](https://cdn.jsdelivr.net/npm/@read-frog/layout-engine@0.2.0/LICENSE) before distribution. Dependency package contents and local browser/test data are not committed to this fork.

## Study counts

With Anki sync enabled, selection translation and custom-action popovers show **Anki · N cards to study** when the configured default deck has available cards. Hover for the deck name and New / Learning / Review breakdown. **Options → Anki** shows the breakdown, unavailable/missing-deck states, and a manual Refresh button.

Counts come from AnkiConnect's `getDeckStats` scheduler tree, including the selected deck's subdecks. They include all cards in that deck, not only notes exported by Read Frog. Local pending exports do not count until they reach Anki. Changing the default deck changes this entry's target; already-synced notes remain in their existing decks. The extension checks that a deck exists before requesting statistics, so checking a new deck does not create it.

The background shares a 60-second in-memory statistics cache across tabs and merges concurrent requests. It checks the active Anki profile even on cache hits, clears failed results, and invalidates counts after confirmed note synchronization or settings changes. Visible open surfaces check every 15 seconds; closing or hiding a surface stops polling, and returning to it forces a refresh. No review counts are persisted in browser storage.

The count is informational text, with no click action, navigation arrow, or desktop-review command. Open Anki yourself to study. Anki must be running with its collection open to supply statistics. No additional companion add-on is needed. Anki's counts are a snapshot of its study queue, not a promise of a fixed number of answer-button presses.

## Local verification

Use the repository's package manager and runtime versions, install the locked dependencies, then run:

```
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm lint
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

`SKIP_FREE_API=true` intentionally skips the upstream live external translation suite. `WXT_SKIP_ENV_VALIDATION=true` is suitable for a local unpacked build without production OAuth/analytics credentials; it is not production deployment validation. The ordinary unit/integration suites use isolated stores, mock AnkiConnect and synthetic text/audio. `RUN_LIVE_ANKI_TTS=true pnpm exec vitest run src/utils/anki/__tests__/edge-tts.live.test.ts` explicitly opts into two live Microsoft requests using fixed synthetic text; it is skipped otherwise. They do not touch a personal Anki collection. The final implementation report records which additional browser, real Anki, and real Edge TTS checks actually ran.

## Repeated local development and rollback

`pnpm build` produces `.output/chrome-mv3`. For a persistent local handoff with a configured identity, see [local handoff setup](LOCAL-HANDOFF.md). Preserve the existing extension ID and browser profile when replacing a build, and reload both the extension and its host webpage after a content-script change.

Rollback the extension by loading an earlier verified unpacked build under the same configured ID, without uninstalling or clearing its data. Retain the build and local identity configuration outside Git. A code rollback does not remove collected notes or reset review history. Older exporters do not understand separated-phrase span metadata: use a recent compatible build if the queue or portable note data contains separated examples.

Main-branch pushes, pull requests and manual dispatch run the offline check workflow. Automatic release packaging remains limited to the upstream repository; pushing this fork does not publish dependency binaries or store packages.

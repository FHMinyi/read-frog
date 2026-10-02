# Read Frog → Anki (desktop, v1)

This fork saves dictionary results directly to a local AnkiConnect endpoint. No Read Frog account is required to queue or sync cards. Dictionary generation still uses your configured AI provider; its normal account/API requirements are unchanged.

## First-time setup

Use a separate browser profile for the first end-to-end test. Do not run the official Read Frog extension and this fork on the same page at the same time, as their content scripts can interfere. Loading the unpacked build keeps the upstream extension permissions; review those permissions before enabling it.

1. Install desktop [Anki](https://apps.ankiweb.net/) and [AnkiConnect](https://ankiweb.net/shared/info/2055492159) from their official sources. Keep Anki running while exporting. Use a separate test profile first, with no personal collection.
2. In the extension, open **Options → Anki**. The default local endpoint is `http://127.0.0.1:8765`. Only loopback addresses are accepted. V1 does not support remote endpoints or API-key authentication.
3. Load the deck list, select your target deck (or type a new deck name), and choose Save & enable sync. The default English voice is `en-US-AriaNeural`. These settings persist locally.
4. Run the built-in Dictionary on a word inside its original sentence, then choose **Save to Anki**. A save is acknowledged after local persistence. The options page shows pending, syncing, error, or synced status; error messages and Retry are available there.

The extension never enables AnkiConnect permissions automatically. If AnkiConnect refuses access, review its configuration and allow only your extension's exact origin if needed; do not expose its port publicly or use a wildcard origin. If your AnkiConnect requires an API key, this version deliberately does not ask you to paste that credential into extension settings.

## Card behavior

- One note with one card per confidently resolved word identity; new sentences append to that note
- Front: collected original sentences only, with their actual target forms highlighted
- Back: contextual definitions/translations, lemma, available phonetics/POS, CET4/CET6 reference labels, sources, word audio and each sentence's audio
- The AI proposes a lemma in context; pinned lexical inflection data checks the relationship. Derivations such as `decide` and `decision` stay separate. Ambiguous or unverified identities stay sentence-scoped rather than being merged incorrectly
- Repeated word + original sentence does not append another example. Additional highlights can be added to the same example
- Updates change note fields, not card scheduling, review history, or deck placement. Changing the default deck applies to new notes; existing notes remain in their existing decks
- A dedicated `Read Frog Context v1` note type keeps a stable key and portable data. Do not rename/delete its fields. The extension rejects conflicting/duplicate note identities rather than guessing

## Queue, audio, and privacy

The queue and audio cache live in the extension's IndexedDB. They survive ordinary browser/service-worker restarts, but not extension removal, browser-profile deletion, or clearing extension data. Export/sync important material to Anki regularly; this queue is not a substitute for collection backups.

While the browser extension is running, a one-minute alarm retries due work with backoff. Anki can be closed when you collect words. Nothing can run while the browser is fully closed; the queue resumes when the extension starts again. A failed audio request keeps the note pending/error until it can be retried; there is no silent text-only export or system-speech fallback.

The existing built-in Edge TTS implementation sends the word and original sentence to Microsoft's online speech service to create MP3 files. That consumer-style endpoint is not an availability-guaranteed public API and can fail or change. Word audio is cached by exact text, voice, provider, and format. The extension copies real MP3 bytes into Anki's media collection before marking a note synced. It never puts temporary URLs or machine-local file paths on cards.

For strict append preservation, use one active desktop exporter per Anki collection. Portable note data supports sequential use from another installation, but AnkiConnect does not provide atomic compare-and-swap for two computers updating the same note simultaneously.

For phone review, use Anki's normal collection **and media** sync, then wait until the phone finishes downloading media before going offline. MP3 and the plain HTML/CSS template are intended to work with AnkiDroid/AnkiMobile. V1 does not create cards from mobile webpages and does not manage AnkiWeb login or synchronization.

## Vocabulary provenance and licensing

CET labels mean exact membership in a pinned, community-maintained ECDICT reference list. They are not official exam coverage, a ranking, or an AI estimate. Both labels can occur; no match stays empty and does not mean “advanced.” See [data provenance](../src/utils/anki/data/README.md) and the bundled `public/licenses/anki-ecdict.txt` for the MIT license, pinned revision, transformations, limitations, counts, and reproducible checksums.

The new Anki card renderer uses its own escaped HTML/CSS and does not use `@read-frog/layout-engine`. The existing extension still depends on that package, whose 0.2.0 license is proprietary and restricts use/distribution to unmodified Read Frog products as distributed by its owner or written permission. This feature does not replace that dependency or establish permission to redistribute the entire fork. Review the package's [published license](https://cdn.jsdelivr.net/npm/@read-frog/layout-engine@0.2.0/LICENSE) before distribution. No remote push, PR, or publication is part of this change.

## Local verification

Use the repository's package manager and runtime versions, install the locked dependencies, then run:

```
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm lint
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

`SKIP_FREE_API=true` intentionally skips the upstream live external translation suite. `WXT_SKIP_ENV_VALIDATION=true` is suitable for a local unpacked build without production OAuth/analytics credentials; it is not production deployment validation. The ordinary unit/integration suites use isolated stores, mock AnkiConnect and synthetic text/audio. `RUN_LIVE_ANKI_TTS=true pnpm exec vitest run src/utils/anki/__tests__/edge-tts.live.test.ts` explicitly opts into two live Microsoft requests using fixed synthetic text; it is skipped otherwise. They do not touch a personal Anki collection. The final implementation report records which additional browser, real Anki, and real Edge TTS checks actually ran.

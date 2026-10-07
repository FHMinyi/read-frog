# Local unpacked handoff

`pnpm build:local` builds Chrome MV3 and runs `scripts/prepare-local-handoff.mjs`. The helper derives directories from its own location, verifies both content-script and shared background validators, copies the build into the sibling `handoff/chrome-mv3`, and preserves the previous delivery in a timestamped backup. It labels each delivery with a version_name and records hashes in BUILD-INFO.json and a local receipt.

## Private identity configuration

Before using the helper, configure `.local-handoff.json` at the source repository root with two string fields:

- `key`: the single-line Base64 value used for the local manifest.key.
- `extensionId`: the existing 32-letter extension ID that the key must reproduce.

This configuration is ignored by Git. Do not commit personal identity seeds, browser settings, queues, credentials, generated builds, receipts or test collections. The helper rejects a mismatching key/ID, a previous delivery with another configured identity, or changed extension permissions. A normal `pnpm build` does not apply this private identity configuration.

For a new reusable development identity, follow [Chrome's public-key instructions](https://developer.chrome.com/docs/extensions/reference/manifest/key). An existing unpacked installation without a key derives its ID from its directory path; moving that directory normally changes its ID. Chromium's current decoder also accepts Base64 identity bytes without validating a DER public-key structure. A legacy path-byte compatibility configuration depends on that implementation, is not a signing key, and must remain local. Do not use such material for signed packages or store distribution, and verify acceptance and the displayed ID in the actual browser.

## Switching and rollback

Keep the current extension installed. Use the same browser profile, choose Load unpacked on chrome://extensions, and select the prepared sibling handoff directory. Check the existing ID, new version_name and actual loaded path before proceeding. If any differ or Chrome rejects the manifest, stop and retain the existing installation. Refresh the host webpage, then verify the existing settings and queue before saving again.

Same-ID loading follows Chromium's update path; uninstalling is unnecessary and can erase extension data. The helper only prepares files and never opens Chrome, reads browser storage or changes AnkiConnect permissions. Its receipt explicitly leaves browser switching/runtime verification unconfirmed.

For rollback, load a compatible timestamped backup under the same ID, retain private configuration, and refresh the host page. Do not clear IndexedDB or uninstall as a rollback step. Old builds that reject separated examples cannot safely act as exporters for a queue containing that metadata.

## Checks

```sh
SKIP_FREE_API=true RUN_LIVE_ANKI_CONNECT=false RUN_LIVE_ANKI_TTS=false pnpm test
pnpm test:dictionary-phonetic
pnpm test:local-handoff
pnpm lint
pnpm fmt:check
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

Native helper tests use synthetic identities and temporary directories; no personal browser configuration is required. Build artifacts and sibling handoff backups remain local and are not part of the source push.

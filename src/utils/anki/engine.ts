import type { AnkiSynthesizer } from "./audio"
import type { AnkiClient } from "./client"
import type { AnkiStore } from "./store"
import type {
  AnkiCapture,
  AnkiCleanupResult,
  AnkiEntry,
  AnkiExample,
  AnkiSettings,
  AnkiSnapshot,
} from "./types"
import { getAnkiAudio, synthesizeAnkiAudio } from "./audio"
import { getCetMembership } from "./cet"
import { AnkiTransportError, createAnkiClient, validateAnkiEndpoint } from "./client"
import { normalizeCapture } from "./normalization"
import {
  ANKI_CSS,
  ANKI_FIELDS,
  ANKI_LEGACY_BACK,
  ANKI_MODEL_NAME,
  ANKI_TEMPLATE,
  renderAnkiFields,
} from "./render"
import { ankiReview } from "./review"
import { createAnkiStore } from "./store"

interface NoteInfo {
  noteId: number
  cards: number[]
  modelName: string
  fields: Record<string, { value: string; order: number }>
}

export interface AnkiEngine {
  enqueue: (captures: AnkiCapture[]) => Promise<AnkiSnapshot>
  getSnapshot: () => Promise<AnkiSnapshot>
  updateSettings: (settings: Partial<AnkiSettings>) => Promise<AnkiSnapshot>
  cleanupCet4: () => Promise<AnkiCleanupResult>
  retry: (key?: string) => Promise<AnkiSnapshot>
  processQueue: () => Promise<void>
}

interface EngineOptions {
  store: AnkiStore
  createClient?: (endpoint: string) => AnkiClient
  synthesize?: AnkiSynthesizer
  now?: () => number
  /** Defaults to a cross-context Web Lock, released automatically when a worker dies. */
  withLock?: (run: () => Promise<void>) => Promise<void>
  onSynced?: () => void
}

// Also serialize test/unsupported-Web-Locks environments within one JS context.
let queueTail: Promise<void> = Promise.resolve()
function withQueueLock(run: () => Promise<void>): Promise<void> {
  const next = queueTail
    .catch(() => {})
    .then(async () => {
      if (globalThis.navigator?.locks) {
        await navigator.locks.request("read-frog-local-anki-sync", run)
      } else {
        await run()
      }
    })
  queueTail = next
  return next
}

/** First captures win contextual metadata; later captures can fill gaps and add surface forms. */
export function mergeAnkiExamples(current: AnkiExample[], incoming: AnkiExample[]): AnkiExample[] {
  const merged = current.map((example) => ({ ...example, forms: [...example.forms] }))
  for (const example of incoming) {
    const existing = merged.find((candidate) => candidate.id === example.id)
    if (!existing) {
      merged.push({ ...example, forms: [...example.forms] })
      continue
    }
    existing.forms = [...new Set([...existing.forms, ...example.forms])]
    for (const field of [
      "definition",
      "translation",
      "phonetic",
      "partOfSpeech",
      "sourceTitle",
      "sourceUrl",
    ] as const) {
      if (!existing[field]) existing[field] = example[field]
    }
    if (!existing.sentenceAudio && example.sentenceAudio)
      existing.sentenceAudio = example.sentenceAudio
  }
  return merged
}

function remoteExamples(note: NoteInfo, entry: Pick<AnkiEntry, "key" | "identity">): AnkiExample[] {
  const encoded = note.fields.Data?.value
  // Refuse to replace an opaque/malformed remote note, which could erase examples from another machine.
  if (!encoded?.startsWith("rf1:") || encoded.length > 4_000_000) {
    throw new Error(
      "Existing Read Frog note has missing or incompatible merge data; it was left unchanged",
    )
  }
  const parsed: unknown = JSON.parse(decodeURIComponent(encoded.slice(4)))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("key" in parsed) ||
    parsed.key !== entry.key ||
    !("identity" in parsed) ||
    parsed.identity !== entry.identity ||
    !("examples" in parsed) ||
    !Array.isArray(parsed.examples)
  )
    throw new Error("Existing Read Frog note identity does not match; it was left unchanged")
  return parsed.examples.map((value: unknown) => {
    if (typeof value !== "object" || value === null)
      throw new Error("Invalid existing example data")
    const example = value as AnkiExample
    const strings = [
      "term",
      "sentence",
      "definition",
      "translation",
      "phonetic",
      "partOfSpeech",
      "sourceTitle",
      "sourceUrl",
    ] as const
    if (
      strings.some((field) => typeof example[field] !== "string") ||
      !Array.isArray(example.forms) ||
      example.forms.some((form) => typeof form !== "string")
    ) {
      throw new Error("Invalid existing example data")
    }
    const normalized = normalizeCapture(example)
    if (normalized.key !== entry.key)
      throw new Error("Existing example belongs to a different word")
    return normalized.example
  })
}

async function ensureModel(client: AnkiClient): Promise<void> {
  const version = await client.invoke<number>("version")
  if (version < 6) throw new Error("AnkiConnect version 6 or newer is required")
  const names = await client.invoke<string[]>("modelNames")
  if (!names.includes(ANKI_MODEL_NAME)) {
    await client.invoke("createModel", {
      modelName: ANKI_MODEL_NAME,
      inOrderFields: [...ANKI_FIELDS],
      css: ANKI_CSS,
      isCloze: false,
      cardTemplates: [ANKI_TEMPLATE],
    })
  }
  const fields = await client.invoke<string[]>("modelFieldNames", { modelName: ANKI_MODEL_NAME })
  const templates = await client.invoke<Record<string, { Front?: string; Back?: string }>>(
    "modelTemplates",
    {
      modelName: ANKI_MODEL_NAME,
    },
  )
  if (
    JSON.stringify(fields) !== JSON.stringify(ANKI_FIELDS) ||
    Object.keys(templates).length !== 1 ||
    templates[ANKI_TEMPLATE.Name]?.Front !== ANKI_TEMPLATE.Front ||
    (templates[ANKI_TEMPLATE.Name]?.Back !== ANKI_TEMPLATE.Back &&
      templates[ANKI_TEMPLATE.Name]?.Back !== ANKI_LEGACY_BACK)
  ) {
    throw new Error("The Read Frog Anki note type was modified incompatibly; no notes were changed")
  }
  if (templates[ANKI_TEMPLATE.Name]?.Back === ANKI_LEGACY_BACK) {
    await client.invoke("updateModelTemplates", {
      model: {
        name: ANKI_MODEL_NAME,
        templates: { [ANKI_TEMPLATE.Name]: { Back: ANKI_TEMPLATE.Back } },
      },
    })
  }
}

async function findNote(client: AnkiClient, entry: AnkiEntry): Promise<NoteInfo | undefined> {
  // RFKey is a deterministic hex digest; never interpolate captured text into Anki search syntax.
  if (!/^rfanki_[a-f0-9]{64}$/.test(entry.key)) throw new Error("Invalid local note key")
  const ids = await client.invoke<number[]>("findNotes", { query: `"RFKey:${entry.key}"` })
  if (ids.length > 1)
    throw new Error(
      "Multiple Anki notes share this Read Frog key; resolve the duplicate notes before retrying",
    )
  if (!ids.length) return undefined
  const [note] = await client.invoke<NoteInfo[]>("notesInfo", { notes: ids })
  if (
    !note ||
    note.noteId !== ids[0] ||
    note.modelName !== ANKI_MODEL_NAME ||
    note.fields.RFKey?.value !== entry.key ||
    ANKI_FIELDS.some((field) => !(field in note.fields))
  )
    throw new Error(
      "An existing Anki note does not match the Read Frog model/key; it was left unchanged",
    )
  return note
}

export const CET4_DECK = "cet4"

function isCet4Entry(entry: Pick<AnkiEntry, "lemma" | "identity">): boolean {
  return entry.identity.startsWith("word:") && getCetMembership(entry.lemma).includes("CET4")
}

function destinationDeck(
  entry: Pick<AnkiEntry, "lemma" | "identity">,
  settings: AnkiSettings,
): string {
  return settings.routeCet4 && isCet4Entry(entry) ? CET4_DECK : settings.deckName
}

export function createAnkiEngine(options: EngineOptions): AnkiEngine {
  const { store } = options
  const now = options.now ?? Date.now
  const makeClient = options.createClient ?? createAnkiClient
  const rawSynthesize = options.synthesize ?? synthesizeAnkiAudio
  const synthesize: AnkiSynthesizer = async (text, voice) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        rawSynthesize(text, voice),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Edge TTS timed out; saved vocabulary will retry with MP3 audio")),
            90_000,
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  const withLock = options.withLock ?? withQueueLock
  let running: Promise<void> | undefined

  async function getSnapshot(): Promise<AnkiSnapshot> {
    const [settings, entries] = await Promise.all([store.getSettings(), store.listEntries()])
    return { settings, entries: entries.sort((left, right) => right.updatedAt - left.updatedAt) }
  }

  async function sync(entry: AnkiEntry, settings: AnkiSettings, client: AnkiClient): Promise<void> {
    let working = entry
    try {
      await ensureModel(client)
      const existing = await findNote(client, entry)
      const remote = existing ? remoteExamples(existing, entry) : []
      working = await store.changeEntry(entry.key, (latest = entry) => {
        const examples = mergeAnkiExamples(latest.examples, remote)
        const changed = JSON.stringify(examples) !== JSON.stringify(latest.examples)
        return {
          ...latest,
          examples,
          revision: latest.revision + Number(changed),
          status: "syncing",
          error: undefined,
        }
      })
      const media = []
      const word = await getAnkiAudio(store, synthesize, working.lemma, settings.voice, now)
      media.push(word)
      working = {
        ...working,
        wordAudio: word.filename,
        examples: working.examples.map((example) => ({ ...example })),
      }
      for (const example of working.examples) {
        const sentence = await getAnkiAudio(
          store,
          synthesize,
          example.sentence,
          settings.voice,
          now,
        )
        example.sentenceAudio = sentence.filename
        media.push(sentence)
      }
      // Each retry checks real Anki media, including missing files after a cross-device sync.
      for (const file of new Map(media.map((item) => [item.filename, item])).values()) {
        const saved = await client.invoke<string | false>("retrieveMediaFile", {
          filename: file.filename,
        })
        if (saved !== file.base64) {
          const filename = await client.invoke<string>("storeMediaFile", {
            filename: file.filename,
            data: file.base64,
          })
          if (filename !== file.filename)
            throw new Error("Anki stored media under an unexpected filename")
        }
      }
      // Respect a disable/settings change that happened while audio was being generated.
      const currentSettings = await store.getSettings()
      if (
        !currentSettings.enabled ||
        currentSettings.endpoint !== settings.endpoint ||
        currentSettings.voice !== settings.voice ||
        (!existing && (await store.getEntry(entry.key))?.deckName !== working.deckName)
      ) {
        await store.changeEntry(entry.key, (latest = working) => ({ ...latest, status: "pending" }))
        return
      }
      // Refresh after slow TTS. AnkiConnect has no compare-and-swap; this narrows the
      // cross-exporter race and preserves changes made while audio was in progress.
      const refreshed = await findNote(client, working)
      if (refreshed?.fields.Data?.value !== existing?.fields.Data?.value) {
        const changedRemote = refreshed ? remoteExamples(refreshed, working) : []
        await store.changeEntry(entry.key, (latest = working) => {
          const examples = mergeAnkiExamples(latest.examples, changedRemote)
          return {
            ...latest,
            examples,
            revision: latest.revision + 1,
            status: "pending",
            nextRetryAt: 0,
          }
        })
        return
      }
      const fields = renderAnkiFields(working)
      let noteId: number
      if (existing) {
        noteId = existing.noteId
        // Do not recreate cards, move decks, change tags, or touch scheduling/review state.
        await client.invoke("updateNoteFields", { note: { id: noteId, fields } })
      } else {
        await client.invoke("createDeck", { deck: working.deckName })
        noteId = await client.invoke<number>("addNote", {
          note: {
            deckName: working.deckName,
            modelName: ANKI_MODEL_NAME,
            fields,
            options: { allowDuplicate: false },
            tags: ["read_frog"],
          },
        })
        if (!Number.isSafeInteger(noteId) || noteId <= 0)
          throw new Error("Anki did not confirm the added note; retry will check its key first")
      }
      const [verified] = await client.invoke<NoteInfo[]>("notesInfo", { notes: [noteId] })
      if (
        !verified ||
        verified.noteId !== noteId ||
        verified.modelName !== ANKI_MODEL_NAME ||
        ANKI_FIELDS.some((field) => verified.fields[field]?.value !== fields[field])
      ) {
        throw new Error("Anki did not retain all note fields; close its editor and retry")
      }
      await store.changeEntry(entry.key, (latest = working) => ({
        ...latest,
        wordAudio: working.wordAudio,
        examples: latest.examples.map((example) => ({
          ...example,
          sentenceAudio:
            working.examples.find((candidate) => candidate.id === example.id)?.sentenceAudio ??
            example.sentenceAudio,
        })),
        noteId,
        syncedRevision: working.revision,
        status: latest.revision === working.revision ? "synced" : "pending",
        attempts: 0,
        nextRetryAt: 0,
        error: undefined,
      }))
      options.onSynced?.()
    } catch (error) {
      await store.changeEntry(entry.key, (latest = working) => {
        const newer = latest.revision !== working.revision
        const attempts = latest.attempts + 1
        const retryCap = error instanceof AnkiTransportError ? 60_000 : 3_600_000
        return {
          ...latest,
          status: newer ? "pending" : "error",
          attempts,
          nextRetryAt: newer
            ? 0
            : now() + Math.min(30_000 * 2 ** Math.min(attempts - 1, 7), retryCap),
          error: error instanceof Error ? error.message : "Anki sync failed",
        }
      })
    }
  }

  async function drain(): Promise<void> {
    // A 'syncing' row can only be stranded when its previous worker died. The Web Lock
    // prevents stealing a live worker's row and is released by browser termination.
    for (const entry of await store.listEntries()) {
      if (entry.status === "syncing") {
        await store.changeEntry(entry.key, (latest = entry) => ({
          ...latest,
          status: "pending",
          nextRetryAt: 0,
        }))
      }
    }
    for (;;) {
      const settings = await store.getSettings()
      if (!settings.enabled) return
      const eligible = (await store.listEntries())
        .filter((entry) => entry.status !== "synced" && entry.nextRetryAt <= now())
        .sort((left, right) => left.updatedAt - right.updatedAt)
      const entry = eligible[0]
      if (!entry) return
      await sync(entry, settings, makeClient(settings.endpoint))
    }
  }

  return {
    getSnapshot,
    async enqueue(captures) {
      // Normalize the entire batch before writes so a malformed capture cannot partially enqueue.
      const normalized = captures.map(normalizeCapture)
      const settings = await store.getSettings()
      for (const item of normalized) {
        await store.changeEntry(item.key, (existing) => {
          if (!existing)
            return {
              key: item.key,
              lemma: item.lemma,
              identity: item.identity,
              examples: [item.example],
              revision: 1,
              syncedRevision: 0,
              status: "pending",
              attempts: 0,
              nextRetryAt: 0,
              updatedAt: now(),
              deckName: destinationDeck(item, settings),
            }
          const examples = mergeAnkiExamples(existing.examples, [item.example])
          if (JSON.stringify(examples) === JSON.stringify(existing.examples)) return existing
          return {
            ...existing,
            examples,
            revision: existing.revision + 1,
            status: "pending",
            nextRetryAt: 0,
            updatedAt: now(),
            error: undefined,
          }
        })
      }
      return getSnapshot()
    },
    async updateSettings(update) {
      const previous = await store.getSettings()
      const settings = { ...previous, ...update }
      settings.endpoint = validateAnkiEndpoint(settings.endpoint)
      settings.deckName = settings.deckName.trim()
      settings.voice = settings.voice.trim()
      if (!settings.deckName || settings.deckName.length > 200)
        throw new Error("Enter a deck name (up to 200 characters)")
      if (!/^[a-z]{2,3}-[A-Za-z0-9-]+$/.test(settings.voice) || settings.voice.length > 100)
        throw new Error("Enter a valid Edge TTS voice name")
      if (typeof settings.enabled !== "boolean") throw new Error("Invalid Anki enabled setting")
      if (typeof settings.routeCet4 !== "boolean") throw new Error("Invalid CET4 routing setting")
      await store.setSettings(settings)
      const audioOrEndpointChanged =
        settings.voice !== previous.voice || settings.endpoint !== previous.endpoint
      const deckChanged =
        settings.deckName !== previous.deckName || settings.routeCet4 !== previous.routeCet4
      if (audioOrEndpointChanged || deckChanged) {
        for (const entry of await store.listEntries()) {
          await store.changeEntry(entry.key, (latest = entry) => {
            const initialDeckChanged = deckChanged && latest.syncedRevision === 0 && !latest.noteId
            if (!audioOrEndpointChanged && !initialDeckChanged) return latest
            return {
              ...latest,
              deckName: initialDeckChanged ? destinationDeck(latest, settings) : latest.deckName,
              revision: latest.revision + 1,
              status: "pending",
              nextRetryAt: 0,
              error: undefined,
            }
          })
        }
      }
      return getSnapshot()
    },
    async cleanupCet4() {
      const result: AnkiCleanupResult = {
        snapshot: await getSnapshot(),
        moved: 0,
        skipped: 0,
        failures: [],
      }
      // Share the sync lock: a queue drain must never overwrite the local deck after a move.
      await withLock(async () => {
        const settings = await store.getSettings()
        const client = makeClient(settings.endpoint)
        // Use a fixed model query, then compare actual deck names exactly. This avoids
        // interpreting user deck names as search syntax or including child decks by accident.
        const ids = await client.invoke<number[]>("findNotes", {
          query: `"note:${ANKI_MODEL_NAME}"`,
        })
        for (const noteId of ids) {
          let lemma = `Note ${noteId}`
          try {
            const [note] = await client.invoke<NoteInfo[]>("notesInfo", { notes: [noteId] })
            if (
              !note ||
              note.noteId !== noteId ||
              note.modelName !== ANKI_MODEL_NAME ||
              ANKI_FIELDS.some((field) => !note.fields?.[field])
            )
              throw new Error("Existing note does not match the Read Frog model; left unchanged")
            if (
              !Array.isArray(note.cards) ||
              note.cards.length !== 1 ||
              !Number.isSafeInteger(note.cards[0]) ||
              note.cards[0]! <= 0
            )
              throw new Error("Expected one existing Read Frog card; left unchanged")
            const decks = await client.invoke<Record<string, number[]>>("getDecks", {
              cards: note.cards,
            })
            const sourceCards = decks[settings.deckName] ?? []
            if (
              !sourceCards.includes(note.cards[0]!) &&
              !decks[CET4_DECK]?.includes(note.cards[0]!)
            ) {
              result.skipped++
              continue
            }
            const encoded = note.fields.Data?.value
            if (!encoded?.startsWith("rf1:") || encoded.length > 4_000_000)
              throw new Error("Missing or incompatible Read Frog data; left unchanged")
            const parsed: unknown = JSON.parse(decodeURIComponent(encoded.slice(4)))
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("examples" in parsed) ||
              !Array.isArray(parsed.examples) ||
              !parsed.examples.length
            )
              throw new Error("Missing Read Frog examples; left unchanged")
            // Rebuild the canonical identity from the saved capture, not the displayed HTML.
            const entry = normalizeCapture(parsed.examples[0])
            lemma = entry.lemma
            if (note.fields.RFKey?.value !== entry.key)
              throw new Error("Read Frog key does not match its example; left unchanged")
            remoteExamples(note, entry)
            if (!isCet4Entry(entry)) {
              result.skipped++
              continue
            }
            const updateLocalDeck = async () => {
              const local = await store.getEntry(entry.key)
              if (local)
                await store.changeEntry(entry.key, (latest = local) => ({
                  ...latest,
                  deckName: CET4_DECK,
                }))
            }
            if (decks[CET4_DECK]?.includes(note.cards[0]!)) {
              // Recover a successful move whose response/local write was interrupted.
              await updateLocalDeck()
              result.skipped++
              continue
            }
            if (sourceCards.length !== 1 || sourceCards[0] !== note.cards[0]) {
              result.skipped++
              continue
            }
            const current = await store.getSettings()
            if (current.endpoint !== settings.endpoint || current.deckName !== settings.deckName)
              throw new Error("Anki settings changed; run cleanup again")
            await client.invoke("changeDeck", { cards: note.cards, deck: CET4_DECK })
            const verified = await client.invoke<Record<string, number[]>>("getDecks", {
              cards: note.cards,
            })
            if (!verified[CET4_DECK]?.includes(note.cards[0]!))
              throw new Error("Anki did not confirm the moved card; run cleanup again")
            await updateLocalDeck()
            result.moved++
            options.onSynced?.()
          } catch (error) {
            result.failures.push({
              lemma,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      })
      result.snapshot = await getSnapshot()
      return result
    },
    async retry(key) {
      for (const entry of await store.listEntries()) {
        if ((!key || key === entry.key) && entry.status !== "synced") {
          await store.changeEntry(entry.key, (latest = entry) => ({
            ...latest,
            status: "pending",
            nextRetryAt: 0,
            error: undefined,
          }))
        }
      }
      return getSnapshot()
    },
    processQueue() {
      running ??= withLock(drain).finally(() => {
        running = undefined
      })
      return running
    },
  }
}

// Lazy construction avoids opening IndexedDB while WXT evaluates background modules at build time.
let singleton: AnkiEngine | undefined
function getEngine(): AnkiEngine {
  singleton ??= createAnkiEngine({ store: createAnkiStore(), onSynced: ankiReview.invalidate })
  return singleton
}
export const ankiEngine: AnkiEngine = {
  enqueue: (captures) => getEngine().enqueue(captures),
  getSnapshot: () => getEngine().getSnapshot(),
  updateSettings: (settings) => getEngine().updateSettings(settings),
  cleanupCet4: () => getEngine().cleanupCet4(),
  retry: (key) => getEngine().retry(key),
  processQueue: () => getEngine().processQueue(),
}

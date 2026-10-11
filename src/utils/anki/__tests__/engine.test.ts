import type { AnkiSynthesizer } from "../audio"
import type { AnkiClient } from "../client"
import type { AnkiCapture, AnkiSettings } from "../types"
import { Dexie } from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AnkiTransportError } from "../client"
import { createAnkiEngine } from "../engine"
import { normalizeCapture } from "../normalization"
import { findSeparatedPhraseMatches } from "../phrases"
import { ANKI_FIELDS, ANKI_MODEL_NAME, ANKI_TEMPLATE } from "../render"
import { AnkiDatabase, createAnkiStore } from "../store"
import { DEFAULT_ANKI_SETTINGS } from "../types"

Dexie.dependencies.indexedDB = indexedDB
Dexie.dependencies.IDBKeyRange = IDBKeyRange

const databases: AnkiDatabase[] = []
let databaseNumber = 0

function capture(sentence = "They work outside.", term = "work"): AnkiCapture {
  return {
    term,
    sentence,
    forms: [term],
    definition: "perform an activity",
    translation: "他们在外面工作。",
    phonetic: "/wɜːk/",
    partOfSpeech: "verb",
    sourceTitle: "Example",
    sourceUrl: "https://example.com/article",
  }
}

function phraseCapture(
  sentence = "All right, we're locking in.",
  form = "locking in",
): AnkiCapture {
  return {
    ...capture(sentence, "lock in"),
    forms: [form],
    definition: "focus completely",
    translation: "我们要全力以赴。",
    phonetic: "/lɒk ɪn/",
    partOfSpeech: "phrasal verb",
  }
}

function database(name = `anki-engine-test-${++databaseNumber}`) {
  const db = new AnkiDatabase(name)
  databases.push(db)
  return db
}

const mp3 = () => ({
  audio: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1]).buffer,
  contentType: "audio/mpeg",
})

function mockAnki() {
  const notes = new Map<
    number,
    { noteId: number; modelName: string; fields: Record<string, { value: string; order: number }> }
  >()
  const cardDecks = new Map<number, string>()
  const media = new Map<string, string>()
  let backTemplate = ANKI_TEMPLATE.Back
  let id = 10
  let loseAddResponse = false
  let mediaFailure = false
  let wrongModel = false
  const schedule = { due: 123, interval: 17, reps: 9 }
  const invoke = vi.fn<(action: string, params?: Record<string, any>) => Promise<unknown>>(
    async (action: string, params: Record<string, any> = {}): Promise<unknown> => {
      switch (action) {
        case "version":
          return 6
        case "modelNames":
          return [ANKI_MODEL_NAME]
        case "modelFieldNames":
          return [...ANKI_FIELDS]
        case "modelTemplates":
          return { Context: { Front: "{{Front}}", Back: backTemplate } }
        case "updateModelTemplates":
          backTemplate = params.model.templates.Context.Back
          return null
        case "getDecks": {
          const result: Record<string, number[]> = {}
          for (const card of params.cards) {
            const deck = cardDecks.get(card)
            if (deck) (result[deck] ??= []).push(card)
          }
          return result
        }
        case "changeDeck":
          for (const card of params.cards) cardDecks.set(card, params.deck)
          return null
        case "createDeck":
          return 1
        case "findNotes":
          return [...notes.values()]
            .filter(
              (note) =>
                params.query === `"note:${ANKI_MODEL_NAME}"` ||
                params.query.includes(note.fields.RFKey!.value),
            )
            .map((note) => note.noteId)
        case "notesInfo":
          return params.notes.map((noteId: number) => ({
            ...structuredClone(notes.get(noteId)),
            cards: [noteId * 10],
            ...(wrongModel ? { modelName: "Basic" } : {}),
          }))
        case "retrieveMediaFile":
          return media.get(params.filename) ?? false
        case "storeMediaFile": {
          if (mediaFailure) {
            mediaFailure = false
            throw new Error("media upload interrupted")
          }
          media.set(params.filename, params.data)
          return params.filename
        }
        case "addNote": {
          if (params.note.options.allowDuplicate !== false)
            throw new Error("Duplicate prevention missing")
          if (
            [...notes.values()].some(
              (note) => note.fields.RFKey!.value === params.note.fields.RFKey,
            )
          )
            throw new Error("duplicate")
          const noteId = ++id
          cardDecks.set(noteId * 10, params.note.deckName)
          notes.set(noteId, {
            noteId,
            modelName: params.note.modelName,
            fields: Object.fromEntries(
              Object.entries(params.note.fields).map(([name, value], order) => [
                name,
                { value: value as string, order },
              ]),
            ),
          })
          if (loseAddResponse) {
            loseAddResponse = false
            throw new Error("response lost after add")
          }
          return noteId
        }
        case "updateNoteFields": {
          const note = notes.get(params.note.id)!
          for (const [name, value] of Object.entries(params.note.fields))
            note.fields[name]!.value = value as string
          return null
        }
        default:
          throw new Error(`Unexpected scheduling/deletion action: ${action}`)
      }
    },
  )
  const client = { invoke } as AnkiClient
  return {
    client,
    invoke,
    notes,
    cardDecks,
    media,
    schedule,
    setBackTemplate: (back: string) => {
      backTemplate = back
    },
    loseNextAddResponse: () => {
      loseAddResponse = true
    },
    failMedia: () => {
      mediaFailure = true
    },
    mismatchModel: () => {
      wrongModel = true
    },
  }
}

async function setup(anki = mockAnki(), settings: Partial<AnkiSettings> = {}) {
  const db = database()
  const store = createAnkiStore(db)
  await store.setSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true, ...settings })
  const synthesize = vi.fn<AnkiSynthesizer>(async () => mp3())
  let time = 1000
  const dependencies = { store, synthesize, createClient: () => anki.client, now: () => time }
  const engine = createAnkiEngine(dependencies)
  return {
    db,
    store,
    anki,
    synthesize,
    dependencies,
    engine,
    advance: () => {
      time += 60_000
    },
  }
}

function actionCount(anki: ReturnType<typeof mockAnki>, action: string) {
  return anki.invoke.mock.calls.filter(([name]) => name === action).length
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) await db.delete()
})

describe("persistent Anki sync engine", () => {
  it("routes only confirmed CET4 words and leaves other vocabulary in the default deck", async () => {
    const { engine, anki } = await setup(mockAnki(), { routeCet4: true })
    await engine.enqueue([
      capture("She has ability.", "ability"),
      phraseCapture(),
      capture("We study photosynthesis.", "photosynthesis"),
      { ...capture("May is here.", "May"), partOfSpeech: "proper noun" },
    ])
    await engine.processQueue()
    const entries = (await engine.getSnapshot()).entries
    expect(entries.find((entry) => entry.lemma === "ability")?.deckName).toBe("cet4")
    expect(
      entries
        .filter((entry) => entry.lemma !== "ability")
        .every((entry) => entry.deckName === "Read Frog"),
    ).toBe(true)
    expect([...anki.cardDecks.values()].filter((deck) => deck === "cet4")).toHaveLength(1)
    expect(actionCount(anki, "changeDeck")).toBe(0)
  })

  it("keeps routing off by default and retargets only unsynced entries when toggled", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture("She has ability.", "ability")])
    await engine.processQueue()
    await engine.enqueue([capture("We abandon the plan.", "abandon")])
    await engine.updateSettings({ routeCet4: true })
    await engine.processQueue()
    expect([...anki.cardDecks.values()]).toEqual(["Read Frog", "cet4"])
    await engine.updateSettings({ routeCet4: false })
    expect([...anki.cardDecks.values()]).toEqual(["Read Frog", "cet4"])
    expect(actionCount(anki, "changeDeck")).toBe(0)
  })

  it("moves a remote CET4 card with no local record, preserving its note and card", async () => {
    const first = await setup()
    await first.engine.enqueue([capture("Graphic design is my passion.", "passion")])
    await first.engine.processQueue()
    const notes = structuredClone([...first.anki.notes.values()])
    const second = await setup(first.anki)
    first.anki.invoke.mockClear()
    const result = await second.engine.cleanupCet4()
    expect(result.moved).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.snapshot.entries).toEqual([])
    expect([...first.anki.notes.values()]).toEqual(notes)
    expect([...first.anki.cardDecks]).toEqual([[notes[0]!.noteId * 10, "cet4"]])
    expect(actionCount(first.anki, "addNote")).toBe(0)
    expect(actionCount(first.anki, "updateNoteFields")).toBe(0)
    expect(second.synthesize).not.toHaveBeenCalled()
  })

  it("refuses malformed remote identities and leaves non-CET4 words untouched without local records", async () => {
    const first = await setup()
    await first.engine.enqueue([
      capture("Graphic design is my passion.", "passion"),
      capture("We abolish the rule.", "abolish"),
      phraseCapture(),
    ])
    await first.engine.processQueue()
    const note = [...first.anki.notes.values()].find((candidate) =>
      candidate.fields.Data!.value.includes("passion"),
    )!
    note.fields.RFKey!.value = `rfanki_${"0".repeat(64)}`
    const second = await setup(first.anki)
    const result = await second.engine.cleanupCet4()
    expect(result.moved).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.error).toContain("key does not match")
    expect(actionCount(first.anki, "changeDeck")).toBe(0)
  })

  it("does not move remote cards in a child deck or a manually chosen deck", async () => {
    const first = await setup()
    await first.engine.enqueue([
      capture("Graphic design is my passion.", "passion"),
      capture("She has ability.", "ability"),
    ])
    await first.engine.processQueue()
    const cards = [...first.anki.cardDecks.keys()]
    first.anki.cardDecks.set(cards[0]!, "Read Frog::Child")
    first.anki.cardDecks.set(cards[1]!, "Manual")
    const second = await setup(first.anki)
    const result = await second.engine.cleanupCet4()
    expect(result.moved).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.failures).toEqual([])
    expect(actionCount(first.anki, "changeDeck")).toBe(0)
  })

  it("explicit cleanup moves the same card without adding notes, media or changing fields", async () => {
    const { engine, anki, synthesize } = await setup()
    await engine.enqueue([capture("She has ability.", "ability")])
    await engine.processQueue()
    const original = structuredClone([...anki.notes.values()])
    const calls = synthesize.mock.calls.length
    anki.invoke.mockClear()
    const result = await engine.cleanupCet4()
    expect(result.moved).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.snapshot.settings.routeCet4).toBe(false)
    expect(result.snapshot.entries[0]?.deckName).toBe("cet4")
    expect([...anki.notes.values()]).toEqual(original)
    expect([...anki.cardDecks]).toEqual([[original[0]!.noteId * 10, "cet4"]])
    expect(synthesize).toHaveBeenCalledTimes(calls)
    expect(actionCount(anki, "addNote")).toBe(0)
    expect(actionCount(anki, "updateNoteFields")).toBe(0)
    expect(actionCount(anki, "storeMediaFile")).toBe(0)
    expect((await engine.cleanupCet4()).moved).toBe(0)
    expect(actionCount(anki, "changeDeck")).toBe(1)
  })

  it("skips manually moved and missing cards and refuses incompatible remote notes", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([
      capture("She has ability.", "ability"),
      capture("We abandon the plan.", "abandon"),
    ])
    await engine.processQueue()
    const cards = [...anki.cardDecks.keys()]
    anki.cardDecks.set(cards[0]!, "Hand sorted")
    anki.notes.delete(cards[1]! / 10)
    expect((await engine.cleanupCet4()).skipped).toBe(1)
    expect(actionCount(anki, "changeDeck")).toBe(0)
    anki.mismatchModel()
    expect((await engine.cleanupCet4()).failures).toHaveLength(1)
    expect(actionCount(anki, "changeDeck")).toBe(0)
  })

  it("requires read-back and recovers a moved card after a lost response", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture("She has ability.", "ability")])
    await engine.processQueue()
    const invoke = anki.client.invoke
    anki.client.invoke = async <T>(
      action: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      const result = await invoke<T>(action, params)
      if (action === "changeDeck") throw new Error("lost response")
      return result
    }
    const failed = await engine.cleanupCet4()
    expect(failed.moved).toBe(0)
    expect(failed.failures).toHaveLength(1)
    expect(failed.snapshot.entries[0]?.deckName).toBe("Read Frog")
    anki.client.invoke = invoke
    const recovered = await engine.cleanupCet4()
    expect(recovered.failures).toEqual([])
    expect(recovered.snapshot.entries[0]?.deckName).toBe("cet4")
    expect(actionCount(anki, "changeDeck")).toBe(1)
  })

  it("does not report success if Anki ignores a move", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture("She has ability.", "ability")])
    await engine.processQueue()
    const invoke = anki.client.invoke
    anki.client.invoke = async <T>(
      action: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      if (action === "changeDeck") return null as T
      return invoke<T>(action, params)
    }
    const result = await engine.cleanupCet4()
    expect(result.moved).toBe(0)
    expect(result.failures[0]?.error).toContain("did not confirm")
    expect(result.snapshot.entries[0]?.deckName).toBe("Read Frog")
  })

  it("invalidates review counts only after confirmed sync, not local enqueue or failure", async () => {
    const { dependencies, anki } = await setup()
    const onSynced = vi.fn<() => void>()
    const engine = createAnkiEngine({ ...dependencies, onSynced })
    await engine.enqueue([capture()])
    expect(onSynced).not.toHaveBeenCalled()
    anki.failMedia()
    await engine.processQueue()
    expect(onSynced).not.toHaveBeenCalled()
    await engine.retry()
    await engine.processQueue()
    expect(onSynced).toHaveBeenCalledOnce()
    expect((await engine.getSnapshot()).entries[0]?.status).toBe("synced")
  })
  it("upgrades only the legacy shared answer template once", async () => {
    const { engine, anki } = await setup()
    anki.setBackTemplate("{{Back}}")
    await engine.enqueue([capture()])
    await engine.processQueue()
    await engine.enqueue([capture("We work together.")])
    await engine.processQueue()
    expect(actionCount(anki, "updateModelTemplates")).toBe(1)
    expect(anki.invoke).toHaveBeenCalledWith("updateModelTemplates", {
      model: { name: ANKI_MODEL_NAME, templates: { Context: { Back: ANKI_TEMPLATE.Back } } },
    })
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(anki.schedule).toEqual({ due: 123, interval: 17, reps: 9 })
  })

  it("leaves a customized answer template and its notes untouched", async () => {
    const { engine, anki } = await setup()
    anki.setBackTemplate("{{Back}}<p>My custom answer</p>")
    await engine.enqueue([capture()])
    await engine.processQueue()
    expect(actionCount(anki, "updateModelTemplates")).toBe(0)
    expect(actionCount(anki, "addNote")).toBe(0)
    expect(actionCount(anki, "updateNoteFields")).toBe(0)
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("incompatibly")
  })

  it("deduplicates captures and concurrent drains, uploads MP3 before adding one card", async () => {
    const { engine, anki, synthesize } = await setup()
    await Promise.all([engine.enqueue([capture()]), engine.enqueue([capture()])])
    const first = engine.processQueue()
    expect(engine.processQueue()).toBe(first)
    await first
    const [entry] = (await engine.getSnapshot()).entries
    expect(entry).toMatchObject({ revision: 1, syncedRevision: 1, status: "synced" })
    expect(entry!.examples).toHaveLength(1)
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(anki.media.size).toBe(2)
    const actions = anki.invoke.mock.calls.map(([action]) => action)
    expect(actions.lastIndexOf("storeMediaFile")).toBeLessThan(actions.indexOf("addNote"))
    expect([...anki.notes.values()][0]!.fields.Back!.value).toContain("[sound:rf_")
  })

  it("updates the same note and preserves scheduling/deck after another sentence", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture()])
    await engine.processQueue()
    const original = (await engine.getSnapshot()).entries[0]!
    await engine.updateSettings({ deckName: "Different default" })
    await engine.enqueue([capture("We work together.")])
    await engine.processQueue()
    const entry = (await engine.getSnapshot()).entries[0]!
    expect(entry.noteId).toBe(original.noteId)
    expect(entry.deckName).toBe("Read Frog")
    expect(entry.examples).toHaveLength(2)
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect(actionCount(anki, "createDeck")).toBe(1)
    expect(anki.schedule).toEqual({ due: 123, interval: 17, reps: 9 })
  })

  it("saves and speaks the whole phrase, appends inflections to one card and preserves its progress", async () => {
    const { engine, anki, synthesize } = await setup()
    await engine.enqueue([phraseCapture(), phraseCapture()])
    await engine.processQueue()
    const original = (await engine.getSnapshot()).entries[0]!
    expect(original).toMatchObject({
      lemma: "lock in",
      identity: "phrase:lock in",
      status: "synced",
    })
    expect(original.examples).toHaveLength(1)
    expect(synthesize).toHaveBeenCalledWith("lock in", "en-US-AriaNeural")
    expect(synthesize).not.toHaveBeenCalledWith("lock", "en-US-AriaNeural")
    await engine.updateSettings({ deckName: "Different default" })
    await engine.enqueue([phraseCapture("We locked in yesterday.", "locked in")])
    await engine.processQueue()
    const entry = (await engine.getSnapshot()).entries[0]!
    expect(entry.key).toBe(original.key)
    expect(entry.noteId).toBe(original.noteId)
    expect(entry.deckName).toBe(original.deckName)
    expect(entry.examples).toHaveLength(2)
    expect(entry.status).toBe("synced")
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect(actionCount(anki, "createDeck")).toBe(1)
    expect(anki.schedule).toEqual({ due: 123, interval: 17, reps: 9 })
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual([
      "lock in",
      "All right, we're locking in.",
      "We locked in yesterday.",
    ])
    expect(anki.media.size).toBe(3)
    const note = [...anki.notes.values()][0]!
    expect(note.fields.Front!.value).toContain("<mark>locking in</mark>")
    expect(note.fields.Front!.value).toContain("<mark>locked in</mark>")
    expect(note.fields.Back!.value).toContain("<mark>locking in</mark>")
    expect(note.fields.Back!.value).toContain("<mark>locked in</mark>")
    expect(note.fields.Back!.value).not.toContain("rf-badge")
    await engine.enqueue([capture("They lock the door.", "lock")])
    await engine.processQueue()
    expect(anki.notes.size).toBe(2)
    const entries = (await engine.getSnapshot()).entries
    expect(entries.find((candidate) => candidate.identity === "word:lock")!.key).not.toBe(entry.key)
  })

  it("merges phrase examples from a second installation instead of replacing an existing note", async () => {
    const anki = mockAnki()
    const first = await setup(anki)
    await first.engine.enqueue([phraseCapture()])
    await first.engine.processQueue()
    const original = (await first.engine.getSnapshot()).entries[0]!
    const second = await setup(anki)
    await second.engine.enqueue([phraseCapture("We locked in yesterday.", "locked in")])
    await second.engine.processQueue()
    const entry = (await second.engine.getSnapshot()).entries[0]!
    expect(entry.noteId).toBe(original.noteId)
    expect(entry.examples).toHaveLength(2)
    expect(anki.notes.size).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect(anki.schedule).toEqual({ due: 123, interval: 17, reps: 9 })
  })

  it("round-trips separated target spans when a second installation appends a continuous example", async () => {
    const sentence = "She walked me through the guide."
    const match = findSeparatedPhraseMatches(sentence, "walk through")[0]!
    const input = {
      ...capture(sentence, "walk through"),
      forms: match.forms,
      phraseSpans: match.spans,
    }
    const anki = mockAnki()
    const first = await setup(anki)
    await first.engine.enqueue([input])
    await first.engine.processQueue()
    const original = (await first.engine.getSnapshot()).entries[0]!
    const second = await setup(anki)
    await second.engine.enqueue([
      {
        ...capture("We walked through the plan together.", "walk through"),
        forms: ["walked through"],
      },
    ])
    await second.engine.processQueue()
    const entry = (await second.engine.getSnapshot()).entries[0]!
    expect(entry.noteId).toBe(original.noteId)
    expect(entry.identity).toBe("phrase:walk through")
    expect(entry.examples).toHaveLength(2)
    expect(entry.examples.find((example) => example.sentence === sentence)!.phraseSpans).toEqual(
      match.spans,
    )
    const note = [...anki.notes.values()][0]!
    expect(note.fields.Front!.value).toContain("<mark>walked</mark> me <mark>through</mark>")
    expect(note.fields.Back!.value).toContain("<mark>walked</mark> me <mark>through</mark>")
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect(anki.schedule).toEqual({ due: 123, interval: 17, reps: 9 })
  })

  it("retains a phrase offline and retries after restarting without duplicate cards", async () => {
    const { engine, anki, dependencies } = await setup()
    const original = anki.client.invoke
    anki.client.invoke = async () => {
      throw new AnkiTransportError("offline")
    }
    await engine.enqueue([phraseCapture()])
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.status).toBe("error")
    expect(anki.notes.size).toBe(0)
    anki.client.invoke = original
    const restarted = createAnkiEngine(dependencies)
    await restarted.retry()
    await restarted.enqueue([phraseCapture()])
    await restarted.processQueue()
    expect((await restarted.getSnapshot()).entries[0]!.status).toBe("synced")
    expect(actionCount(anki, "addNote")).toBe(1)
  })

  it("merges additional surface forms without duplicating an example", async () => {
    const { engine } = await setup()
    const input = capture("They work while she works.")
    await engine.enqueue([input])
    await engine.enqueue([{ ...input, forms: ["works"] }])
    const entry = (await engine.getSnapshot()).entries[0]!
    expect(entry.examples).toHaveLength(1)
    expect(entry.examples[0]!.forms).toEqual(["work", "works"])
    expect(entry.revision).toBe(2)
  })

  it("recovers a committed add with a lost response after a real database close/reopen", async () => {
    const { engine, db, anki, synthesize, advance } = await setup()
    anki.loseNextAddResponse()
    await engine.enqueue([capture()])
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.status).toBe("error")
    expect(anki.notes.size).toBe(1)
    db.close()
    const reopened = database(db.name)
    const restoredStore = createAnkiStore(reopened)
    expect((await restoredStore.listEntries())[0]!.examples).toHaveLength(1)
    expect(await reopened.media.count()).toBe(2)
    advance()
    const restarted = createAnkiEngine({
      store: restoredStore,
      synthesize,
      createClient: () => anki.client,
      now: () => 100_000,
    })
    await restarted.processQueue()
    expect((await restarted.getSnapshot()).entries[0]!.status).toBe("synced")
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it("recovers stranded syncing rows when a worker restarts", async () => {
    const { engine, store, dependencies, anki } = await setup()
    await engine.enqueue([capture()])
    const key = normalizeCapture(capture()).key
    await store.changeEntry(key, (entry) => ({ ...entry!, status: "syncing" }))
    const restarted = createAnkiEngine(dependencies)
    await restarted.processQueue()
    expect((await restarted.getSnapshot()).entries[0]!.status).toBe("synced")
    expect(anki.notes.size).toBe(1)
  })

  it("keeps failed media queued and reuses persisted synthesis on retry", async () => {
    const { engine, anki, synthesize } = await setup()
    anki.failMedia()
    await engine.enqueue([capture()])
    await engine.processQueue()
    expect(anki.notes.size).toBe(0)
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("media upload")
    await engine.retry()
    await engine.processQueue()
    expect(anki.notes.size).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it("continues other words after a TTS failure and honors retry backoff", async () => {
    const { engine, synthesize, anki } = await setup()
    synthesize.mockRejectedValueOnce(new Error("TTS unavailable"))
    await engine.enqueue([capture(), capture("Cats sleep outside.", "sleep")])
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries.map((entry) => entry.status).sort()).toEqual([
      "error",
      "synced",
    ])
    expect(anki.notes.size).toBe(1)
    const count = synthesize.mock.calls.length
    await engine.processQueue()
    expect(synthesize).toHaveBeenCalledTimes(count)
    await engine.retry()
    await engine.processQueue()
    expect(anki.notes.size).toBe(2)
  })

  it("does not acknowledge a newer revision while an older one is in flight", async () => {
    const { engine, synthesize, anki } = await setup()
    const gate = deferred<ReturnType<typeof mp3>>()
    const entered = deferred<void>()
    synthesize.mockImplementationOnce(async () => {
      entered.resolve()
      return gate.promise
    })
    await engine.enqueue([capture()])
    const processing = engine.processQueue()
    await entered.promise
    await engine.enqueue([capture("We work together.")])
    gate.resolve(mp3())
    await processing
    const entry = (await engine.getSnapshot()).entries[0]!
    expect(entry.examples).toHaveLength(2)
    expect(entry.syncedRevision).toBe(entry.revision)
    expect(entry.status).toBe("synced")
    expect(actionCount(anki, "addNote")).toBe(1)
    expect(actionCount(anki, "updateNoteFields")).toBe(1)
    expect([...anki.notes.values()][0]!.fields.Front!.value).toContain("together")
  })

  it("merges existing examples from another installation instead of replacing them", async () => {
    const anki = mockAnki()
    const first = await setup(anki)
    await first.engine.enqueue([capture()])
    await first.engine.processQueue()
    const second = await setup(anki)
    await second.engine.enqueue([capture("We work together.")])
    await second.engine.processQueue()
    expect(anki.notes.size).toBe(1)
    const entry = (await second.engine.getSnapshot()).entries[0]!
    expect(entry.examples).toHaveLength(2)
    const html = [...anki.notes.values()][0]!.fields.Front!.value
    expect(html).toContain("outside")
    expect(html).toContain("together")
  })

  it("refuses incompatible note models without updating their fields", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture()])
    await engine.processQueue()
    anki.mismatchModel()
    await engine.enqueue([capture("We work together.")])
    await engine.processQueue()
    expect(actionCount(anki, "updateNoteFields")).toBe(0)
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("model/key")
  })

  it("rechecks actual media and repairs a missing MP3 without resynthesis", async () => {
    const { engine, anki, synthesize } = await setup()
    await engine.enqueue([capture()])
    await engine.processQueue()
    anki.media.clear()
    await engine.enqueue([capture("We work together.")])
    await engine.processQueue()
    expect(synthesize).toHaveBeenCalledTimes(3)
    expect(anki.media.size).toBe(3)
    expect(actionCount(anki, "storeMediaFile")).toBe(5)
  })

  it("bounds stalled synthesis and ignores its late completion", async () => {
    const { engine, synthesize, anki, db } = await setup()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const gate = deferred<ReturnType<typeof mp3>>()
    const entered = deferred<void>()
    synthesize.mockImplementationOnce(async () => {
      entered.resolve()
      return gate.promise
    })
    await engine.enqueue([capture()])
    const processing = engine.processQueue()
    await entered.promise
    await vi.advanceTimersByTimeAsync(90_001)
    await processing
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("timed out")
    gate.resolve(mp3())
    await Promise.resolve()
    expect(await db.media.count()).toBe(0)
    expect(anki.notes.size).toBe(0)
  })

  it("uses the selected deck for vocabulary queued before first setup", async () => {
    const { engine, anki } = await setup(mockAnki(), { enabled: false })
    await engine.enqueue([capture()])
    await engine.updateSettings({ enabled: true, deckName: "Vocabulary" })
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.deckName).toBe("Vocabulary")
    expect(anki.invoke).toHaveBeenCalledWith("createDeck", { deck: "Vocabulary" })
  })

  it("requires a read-back before acknowledging an update", async () => {
    const { engine, anki } = await setup()
    await engine.enqueue([capture()])
    await engine.processQueue()
    const original = anki.client.invoke
    const invoke: AnkiClient["invoke"] = async <T>(
      action: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      if (action === "updateNoteFields") return null as T
      return original<T>(action, params)
    }
    anki.client.invoke = invoke
    await engine.enqueue([capture("We work together.")])
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.status).toBe("error")
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("did not retain")
  })

  it("reconnects within one minute even after a prolonged offline outage", async () => {
    const { engine, anki, store, advance } = await setup()
    await engine.enqueue([capture()])
    const key = normalizeCapture(capture()).key
    await store.changeEntry(key, (entry) => ({ ...entry!, attempts: 12 }))
    const original = anki.client.invoke
    anki.client.invoke = async () => {
      throw new AnkiTransportError("offline")
    }
    await engine.processQueue()
    const failed = (await engine.getSnapshot()).entries[0]!
    expect(failed.nextRetryAt).toBe(61_000)
    anki.client.invoke = original
    advance()
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.status).toBe("synced")
  })

  it("rejects a template that exposes the answer on the front", async () => {
    const { engine, anki } = await setup()
    const original = anki.client.invoke
    anki.client.invoke = async <T>(
      action: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      if (action === "modelTemplates")
        return { Context: { Front: "{{Back}}", Back: "{{Back}}" } } as T
      return original<T>(action, params)
    }
    await engine.enqueue([capture()])
    await engine.processQueue()
    expect((await engine.getSnapshot()).entries[0]!.error).toContain("incompatibly")
    expect(actionCount(anki, "addNote")).toBe(0)
  })

  it("does no network work while disabled and remembers settings across reopening", async () => {
    const { engine, anki, db } = await setup(mockAnki(), { enabled: false })
    await engine.enqueue([capture()])
    await engine.processQueue()
    expect(anki.invoke).not.toHaveBeenCalled()
    db.close()
    expect((await createAnkiStore(database(db.name)).getSettings()).enabled).toBe(false)
  })
})

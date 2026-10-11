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
        case "createDeck":
          return 1
        case "findNotes":
          return [...notes.values()]
            .filter((note) => params.query.includes(note.fields.RFKey!.value))
            .map((note) => note.noteId)
        case "notesInfo":
          return params.notes.map((noteId: number) => ({
            ...structuredClone(notes.get(noteId)),
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

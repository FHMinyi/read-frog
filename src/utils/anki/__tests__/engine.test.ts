import type { AnkiSynthesizer } from "../audio"
import type { AnkiClient } from "../client"
import type { AnkiCapture, AnkiSettings } from "../types"
import { Dexie } from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AnkiTransportError } from "../client"
import { createAnkiEngine } from "../engine"
import { normalizeCapture } from "../normalization"
import { ANKI_FIELDS, ANKI_MODEL_NAME } from "../render"
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
          return { Context: { Front: "{{Front}}", Back: "{{Back}}" } }
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

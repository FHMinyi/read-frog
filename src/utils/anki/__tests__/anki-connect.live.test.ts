import type { AnkiCapture } from "../types"
import { writeFile } from "node:fs/promises"
import { Dexie } from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { describe, expect, it } from "vitest"
import { createAnkiClient } from "../client"
import { createAnkiEngine } from "../engine"
import { normalizeCapture } from "../normalization"
import { AnkiDatabase, createAnkiStore } from "../store"

/** Never run against a personal collection. Requires an explicit, isolated ReadFrogTest profile. */
describe.skipIf(process.env.RUN_LIVE_ANKI_CONNECT !== "true")(
  "real isolated AnkiConnect + built-in Edge TTS",
  () => {
    it("creates one offline-audio card, reviews it, and appends without changing the scheduler", async () => {
      const client = createAnkiClient("http://127.0.0.1:8765")
      expect(await client.invoke("getActiveProfile")).toBe("ReadFrogTest")
      const capture: AnkiCapture = {
        term: "blossom",
        sentence: "The blossoms are beautiful.",
        forms: ["blossoms"],
        definition: "flowers",
        translation: "花很美。",
        phonetic: "/ˈblɒsəm/",
        partOfSpeech: "noun",
        sourceTitle: "Synthetic integration test",
        sourceUrl: "https://example.com",
      }
      const key = normalizeCapture(capture).key
      expect(await client.invoke("findNotes", { query: `"RFKey:${key}"` })).toEqual([])
      Dexie.dependencies.indexedDB = indexedDB
      Dexie.dependencies.IDBKeyRange = IDBKeyRange
      const db = new AnkiDatabase(`read-frog-live-test-${Date.now()}`)
      const engine = createAnkiEngine({ store: createAnkiStore(db) })
      try {
        await engine.enqueue([capture])
        await engine.updateSettings({ enabled: true, deckName: "Read Frog Integration Test" })
        await engine.processQueue()
        let snapshot = await engine.getSnapshot()
        expect(snapshot.entries[0]?.error).toBeUndefined()
        expect(snapshot.entries[0]?.status).toBe("synced")
        const noteId = snapshot.entries[0]!.noteId!
        const cards = await client.invoke<number[]>("findCards", { query: `nid:${noteId}` })
        expect(cards).toHaveLength(1)
        expect(
          await client.invoke("answerCards", { answers: [{ cardId: cards[0], ease: 4 }] }),
        ).toEqual([true])
        const [before] = await client.invoke<Array<Record<string, unknown>>>("cardsInfo", { cards })
        const reviewsBefore = await client.invoke<Record<string, unknown[]>>("getReviewsOfCards", {
          cards,
        })
        expect(reviewsBefore[String(cards[0])]?.length).toBeGreaterThan(0)
        const schedulingKeys = [
          "cardId",
          "note",
          "deckName",
          "due",
          "interval",
          "factor",
          "reps",
          "lapses",
          "type",
          "queue",
        ]
        const scheduler = (info: Record<string, unknown>) =>
          Object.fromEntries(schedulingKeys.map((field) => [field, info[field]]))
        await engine.enqueue([
          {
            ...capture,
            sentence: "The garden is full of blossoms.",
            translation: "花园里开满了花。",
          },
        ])
        await engine.processQueue()
        snapshot = await engine.getSnapshot()
        expect(snapshot.entries[0]?.error).toBeUndefined()
        expect(snapshot.entries[0]?.status).toBe("synced")
        expect(snapshot.entries[0]?.noteId).toBe(noteId)
        expect(snapshot.entries[0]?.examples).toHaveLength(2)
        const [after] = await client.invoke<Array<Record<string, unknown>>>("cardsInfo", { cards })
        expect(scheduler(after!)).toEqual(scheduler(before!))
        expect(await client.invoke("getReviewsOfCards", { cards })).toEqual(reviewsBefore)
        expect(await client.invoke("findNotes", { query: `"RFKey:${key}"` })).toEqual([noteId])
        await engine.enqueue([capture])
        await engine.processQueue()
        expect((await engine.getSnapshot()).entries[0]?.examples).toHaveLength(2)
        const media = await db.media.toArray()
        expect(media).toHaveLength(3)
        const returned = await Promise.all(
          media.map((file) => client.invoke("retrieveMediaFile", { filename: file.filename })),
        )
        expect(returned).toEqual(media.map((file) => file.base64))
        const [note] = await client.invoke<Array<{ fields: Record<string, { value: string }> }>>(
          "notesInfo",
          { notes: [noteId] },
        )
        expect(note!.fields.Front!.value).toContain("<mark>blossoms</mark>")
        expect(note!.fields.Front!.value).not.toContain("[sound:")
        expect(note!.fields.Back!.value.match(/\[sound:/g)).toHaveLength(3)
        if (process.env.ANKI_LIVE_REPORT) {
          await writeFile(
            process.env.ANKI_LIVE_REPORT,
            JSON.stringify(
              {
                profile: "ReadFrogTest",
                noteId,
                cards,
                schedulerBefore: scheduler(before!),
                schedulerAfter: scheduler(after!),
                reviewsBefore,
                reviewsAfter: await client.invoke("getReviewsOfCards", { cards }),
                media: media.map((file) => ({
                  filename: file.filename,
                  bytes: Buffer.from(file.base64, "base64").byteLength,
                })),
                examples: snapshot.entries[0]?.examples.length,
                noteFields: note!.fields,
              },
              null,
              2,
            ),
          )
        }
      } finally {
        db.close()
      }
    }, 180_000)
  },
)

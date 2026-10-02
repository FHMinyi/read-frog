import type { Table } from "dexie"
import type { AnkiEntry, AnkiSettings } from "./types"
import { Dexie } from "dexie"
import { DEFAULT_ANKI_SETTINGS } from "./types"

export interface AnkiMedia {
  /** Includes provider, format, voice and exact text, so voice changes never reuse wrong audio. */
  key: string
  filename: string
  base64: string
  contentType: string
  createdAt: number
}

export interface AnkiStore {
  getSettings: () => Promise<AnkiSettings>
  setSettings: (settings: AnkiSettings) => Promise<void>
  listEntries: () => Promise<AnkiEntry[]>
  getEntry: (key: string) => Promise<AnkiEntry | undefined>
  /** The callback is synchronous and executes inside one read/write transaction. */
  changeEntry: (key: string, change: (entry?: AnkiEntry) => AnkiEntry) => Promise<AnkiEntry>
  getMedia: (key: string) => Promise<AnkiMedia | undefined>
  putMedia: (media: AnkiMedia) => Promise<void>
}

/** Isolated from account/server vocabulary and its migrations. */
export class AnkiDatabase extends Dexie {
  entries!: Table<AnkiEntry, string>
  media!: Table<AnkiMedia, string>
  settings!: Table<{ id: string; value: AnkiSettings }, string>

  constructor(name = "read-frog-local-anki") {
    super(name)
    this.version(1).stores({
      entries: "key, status, nextRetryAt, updatedAt",
      media: "key, filename",
      settings: "id",
    })
  }
}

export function createAnkiStore(db: AnkiDatabase = new AnkiDatabase()): AnkiStore {
  return {
    async getSettings() {
      return { ...DEFAULT_ANKI_SETTINGS, ...(await db.settings.get("settings"))?.value }
    },
    async setSettings(settings) {
      await db.settings.put({ id: "settings", value: settings })
    },
    listEntries: () => db.entries.toArray(),
    getEntry: (key) => db.entries.get(key),
    async changeEntry(key, change) {
      return db.transaction("rw", db.entries, async () => {
        const next = change(await db.entries.get(key))
        await db.entries.put(next)
        return next
      })
    },
    getMedia: (key) => db.media.get(key),
    async putMedia(media) {
      await db.media.put(media)
    },
  }
}

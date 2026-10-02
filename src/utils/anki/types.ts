/** Persisted locally in the extension; no Read Frog account is involved. */
export interface AnkiCapture {
  term: string
  sentence: string
  /** Exact surface form(s) actually present in the original sentence. */
  forms: string[]
  definition: string
  translation: string
  phonetic: string
  partOfSpeech: string
  sourceTitle: string
  sourceUrl: string
}

export interface AnkiExample extends AnkiCapture {
  id: string
  sentenceAudio?: string
}

export interface AnkiEntry {
  key: string
  lemma: string
  identity: string
  examples: AnkiExample[]
  wordAudio?: string
  noteId?: number
  revision: number
  syncedRevision: number
  status: "pending" | "syncing" | "error" | "synced"
  error?: string
  attempts: number
  nextRetryAt: number
  updatedAt: number
  /** Once first synced, changes to the default deck do not move this note. */
  deckName: string
}

export interface AnkiSettings {
  endpoint: string
  deckName: string
  voice: string
  enabled: boolean
}

export interface AnkiSnapshot {
  settings: AnkiSettings
  entries: AnkiEntry[]
}

export const DEFAULT_ANKI_SETTINGS: AnkiSettings = {
  endpoint: "http://127.0.0.1:8765",
  deckName: "Read Frog",
  voice: "en-US-AriaNeural",
  enabled: false,
}

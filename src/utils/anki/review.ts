import type { AnkiClient } from "./client"
import type { AnkiReviewStatus, AnkiSettings } from "./types"
import { createAnkiClient } from "./client"
import { createAnkiStore } from "./store"

const CACHE_MS = 60_000

interface ReviewOptions {
  getSettings: () => Promise<AnkiSettings>
  createClient?: (endpoint: string) => AnkiClient
  now?: () => number
}

/** One cache in the MV3 worker; profile checks stay live even on a cache hit. */
export function createAnkiReviewService(options: ReviewOptions) {
  const makeClient = options.createClient ?? createAnkiClient
  const now = options.now ?? Date.now
  let revision = 0
  let cached: Extract<AnkiReviewStatus, { state: "ready" }> | undefined
  let pending:
    | { key: string; refresh: { force: boolean }; result: Promise<AnkiReviewStatus> }
    | undefined

  const invalidate = () => {
    revision++
    cached = undefined
    pending = undefined
  }

  async function read(
    settings: AnkiSettings,
    refresh: { force: boolean },
  ): Promise<AnkiReviewStatus> {
    const { endpoint, deckName } = settings
    const version = revision
    try {
      const client = makeClient(endpoint)
      const profileName = await client.invoke<string>("getActiveProfile")
      if (typeof profileName !== "string" || !profileName) throw new Error("Missing Anki profile")
      if (
        !refresh.force &&
        cached?.endpoint === endpoint &&
        cached.deckName === deckName &&
        cached.profileName === profileName &&
        now() - cached.checkedAt < CACHE_MS &&
        version === revision
      ) {
        return cached
      }
      cached = undefined
      // getDeckStats resolves names through decks.id(), which may create a missing deck.
      const decks = await client.invoke<string[]>("deckNames")
      if (!Array.isArray(decks) || !decks.includes(deckName)) {
        return { state: "missing-deck", deckName }
      }
      const stats = await client.invoke<Record<string, Record<string, unknown>>>("getDeckStats", {
        decks: [deckName],
      })
      const deck = Object.values(stats).find((item) => item?.name === deckName)
      const counts = [deck?.new_count, deck?.learn_count, deck?.review_count]
      if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) {
        throw new Error("Invalid Anki deck statistics")
      }
      // A profile or settings change during I/O must never publish the previous collection.
      const latest = await options.getSettings()
      if (
        version !== revision ||
        !latest.enabled ||
        latest.endpoint !== endpoint ||
        latest.deckName !== deckName ||
        (await client.invoke<string>("getActiveProfile")) !== profileName
      ) {
        return { state: "unavailable", deckName }
      }
      const status = {
        state: "ready" as const,
        endpoint,
        deckName,
        profileName,
        newCount: counts[0] as number,
        learningCount: counts[1] as number,
        reviewCount: counts[2] as number,
        checkedAt: now(),
      }
      cached = status
      return status
    } catch {
      cached = undefined
      return { state: "unavailable", deckName }
    }
  }

  return {
    invalidate,
    async getStatus(force = false): Promise<AnkiReviewStatus> {
      const settings = await options.getSettings()
      if (!settings.enabled) {
        invalidate()
        return { state: "disabled", deckName: settings.deckName }
      }
      const key = JSON.stringify([settings.endpoint, settings.deckName, revision])
      // A forced refresh joins an existing refresh rather than starting one per tab.
      if (pending?.key === key) {
        pending.refresh.force ||= force
        return pending.result
      }
      const refresh = { force }
      const request = { key, refresh, result: read(settings, refresh) }
      pending = request
      try {
        return await request.result
      } finally {
        if (pending === request) pending = undefined
      }
    },
  }
}

// Construction stays lazy so WXT can evaluate this module without opening IndexedDB.
let store: ReturnType<typeof createAnkiStore> | undefined
export const ankiReview = createAnkiReviewService({
  getSettings: () => {
    store ??= createAnkiStore()
    return store.getSettings()
  },
})

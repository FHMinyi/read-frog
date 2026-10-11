import { TextEncoder } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAnkiClient } from "../client"
import { createAnkiReviewService } from "../review"
import { DEFAULT_ANKI_SETTINGS } from "../types"

/** Explicit opt-in, read-only: never create decks, add/answer cards or switch profiles. */
describe.skipIf(process.env.RUN_LIVE_ANKI_REVIEW !== "true")("real Anki review statistics", () => {
  // The shared jsdom workaround truncates non-ASCII bytes; real HTTP needs UTF-8.
  beforeEach(() => vi.stubGlobal("TextEncoder", TextEncoder))
  afterEach(() => vi.unstubAllGlobals())
  it("matches the configured deck's actual scheduler counts without creating missing decks", async () => {
    const settings = {
      ...DEFAULT_ANKI_SETTINGS,
      enabled: true,
      deckName: process.env.ANKI_REVIEW_DECK ?? "Read Frog",
    }
    const client = createAnkiClient(settings.endpoint)
    const before = await client.invoke<string[]>("deckNames")
    expect(before).toContain(settings.deckName)
    const profile = await client.invoke<string>("getActiveProfile")
    const stats = await client.invoke<
      Record<string, { name: string; new_count: number; learn_count: number; review_count: number }>
    >("getDeckStats", { decks: [settings.deckName] })
    const deck = Object.values(stats).find((item) => item.name === settings.deckName)!
    const service = createAnkiReviewService({ getSettings: async () => settings })
    expect(await service.getStatus()).toMatchObject({
      state: "ready",
      profileName: profile,
      deckName: settings.deckName,
      newCount: deck.new_count,
      learningCount: deck.learn_count,
      reviewCount: deck.review_count,
    })
    settings.deckName = `Read Frog missing deck check ${Date.now()}`
    expect(await service.getStatus()).toMatchObject({ state: "missing-deck" })
    expect(await client.invoke("deckNames")).toEqual(before)
    expect(await client.invoke("getActiveProfile")).toBe(profile)
  })
})

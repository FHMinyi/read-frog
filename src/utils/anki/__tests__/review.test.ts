import type { AnkiClient } from "../client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAnkiReviewService } from "../review"
import { DEFAULT_ANKI_SETTINGS } from "../types"

describe("Anki review status", () => {
  let settings = { ...DEFAULT_ANKI_SETTINGS, enabled: true }
  let profile = "Personal"
  let clock = 1000
  let counts = { name: "Read Frog", new_count: 10, learn_count: 3, review_count: 7 }
  const invoke = vi.fn<(action: string, params?: Record<string, unknown>) => Promise<unknown>>()
  const client: AnkiClient = {
    invoke: async <T>(action: string, params?: Record<string, unknown>) =>
      (await invoke(action, params)) as T,
  }
  const make = () =>
    createAnkiReviewService({
      getSettings: async () => ({ ...settings }),
      createClient: () => client,
      now: () => clock,
    })

  beforeEach(() => {
    settings = { ...DEFAULT_ANKI_SETTINGS, enabled: true }
    profile = "Personal"
    clock = 1000
    counts = { name: "Read Frog", new_count: 10, learn_count: 3, review_count: 7 }
    invoke.mockReset()
    invoke.mockImplementation(async (action: string) => {
      const result =
        action === "getActiveProfile"
          ? profile
          : action === "deckNames"
            ? ["Read Frog", "Other"]
            : action === "getDeckStats"
              ? { "1": { ...counts, name: settings.deckName } }
              : undefined
      return result
    })
  })

  it("reads scheduler counts, shares requests across surfaces and expires its cache", async () => {
    const service = make()
    const [first, second] = await Promise.all([service.getStatus(), service.getStatus()])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ state: "ready", newCount: 10, learningCount: 3, reviewCount: 7 })
    expect(invoke.mock.calls.filter(([action]) => action === "getDeckStats")).toHaveLength(1)
    counts.review_count = 2
    expect(await service.getStatus()).toMatchObject({ reviewCount: 7 })
    clock += 60_000
    expect(await service.getStatus()).toMatchObject({ reviewCount: 2 })
    expect(invoke).toHaveBeenCalledWith("getDeckStats", { decks: ["Read Frog"] })
  })

  it("refreshes after confirmed synchronization or an explicit refresh", async () => {
    const service = make()
    await service.getStatus()
    counts.new_count++
    expect(await service.getStatus()).toMatchObject({ newCount: 10 })
    service.invalidate()
    expect(await service.getStatus()).toMatchObject({ newCount: 11 })
    counts.review_count = 1
    expect(await service.getStatus(true)).toMatchObject({ reviewCount: 1 })
  })
  it("upgrades a concurrent cache read to a forced refresh without duplicate stats requests", async () => {
    const service = make()
    await service.getStatus()
    counts.new_count = 15
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    invoke.mockImplementationOnce(async () => {
      await gate
      return profile
    })
    const first = service.getStatus()
    const forced = service.getStatus(true)
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([action]) => action === "getActiveProfile")).toHaveLength(3),
    )
    finish()
    const results = await Promise.all([first, forced])
    expect(results[0]).toMatchObject({ newCount: 15 })
    expect(results[1]).toEqual(results[0])
    expect(invoke.mock.calls.filter(([action]) => action === "getDeckStats")).toHaveLength(2)
  })

  it("checks the live profile on cache hits and never retains counts after disconnection", async () => {
    const service = make()
    await service.getStatus()
    profile = "Other profile"
    counts.new_count = 0
    expect(await service.getStatus()).toMatchObject({ profileName: profile, newCount: 0 })
    invoke.mockRejectedValueOnce(new Error("Connection refused"))
    expect(await service.getStatus()).toEqual({ state: "unavailable", deckName: "Read Frog" })
    counts.review_count = 0
    expect(await service.getStatus()).toMatchObject({ reviewCount: 0 })
  })

  it("does not call Anki when disabled or create a missing deck while checking", async () => {
    const service = make()
    settings.enabled = false
    expect(await service.getStatus()).toMatchObject({ state: "disabled" })
    expect(invoke).not.toHaveBeenCalled()
    settings.enabled = true
    settings.deckName = "Not created"
    expect(await service.getStatus()).toMatchObject({ state: "missing-deck" })
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(["getActiveProfile", "deckNames"])
  })

  it("rejects invalid statistics and a profile switch while a request is in flight", async () => {
    const service = make()
    counts.review_count = -1
    expect(await service.getStatus()).toMatchObject({ state: "unavailable" })
    counts.review_count = 2
    invoke.mockImplementationOnce(async () => {
      const previous = profile
      profile = "Changed mid-request"
      return previous
    })
    expect(await service.getStatus()).toMatchObject({ state: "unavailable" })
    expect(await service.getStatus()).toMatchObject({ state: "ready", profileName: profile })
  })

  it("does not cache an in-flight result invalidated by a completed sync", async () => {
    const service = make()
    const normal = invoke.getMockImplementation()!
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    invoke.mockImplementation(async (action: string, params?: Record<string, unknown>) => {
      if (action === "getDeckStats") await gate
      return normal(action, params)
    })
    const pending = service.getStatus()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("getDeckStats", { decks: ["Read Frog"] }),
    )
    service.invalidate()
    finish()
    expect(await pending).toMatchObject({ state: "unavailable" })
    counts.new_count = 20
    expect(await service.getStatus()).toMatchObject({ newCount: 20 })
  })
})

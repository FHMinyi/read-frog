import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (input: any) => any>(),
  alarmListeners: [] as Array<(alarm: { name: string }) => void>,
  startupListeners: [] as Array<() => void>,
  installedListeners: [] as Array<() => void>,
  createAlarm: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  processQueue: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  enqueue: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ settings: {}, entries: [] }),
  getSnapshot: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ settings: {}, entries: [] }),
  updateSettings: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ settings: {}, entries: [] }),
  cleanupCet4: vi.fn<() => Promise<unknown>>().mockResolvedValue({ moved: 1 }),
  retry: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ settings: {}, entries: [] }),
  invoke: vi.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue(["Read Frog"]),
  invalidate: vi.fn<() => void>(),
  getStatus: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ state: "disabled", deckName: "Read Frog" }),
}))
vi.mock("wxt/browser", () => ({
  browser: {
    alarms: {
      create: mocks.createAlarm,
      onAlarm: {
        addListener: (fn: (typeof mocks.alarmListeners)[number]) => mocks.alarmListeners.push(fn),
      },
    },
    runtime: {
      onStartup: { addListener: (fn: () => void) => mocks.startupListeners.push(fn) },
      onInstalled: { addListener: (fn: () => void) => mocks.installedListeners.push(fn) },
    },
  },
}))
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, fn: (input: any) => any) => mocks.handlers.set(name, fn),
}))
vi.mock("@/utils/anki/engine", () => ({ ankiEngine: mocks }))
vi.mock("@/utils/anki/review", () => ({ ankiReview: mocks }))
vi.mock("@/utils/anki/client", () => ({ createAnkiClient: () => ({ invoke: mocks.invoke }) }))
import { ANKI_RETRY_ALARM, setupAnkiMessageHandlers } from "../anki"

const capture = {
  term: "walk",
  sentence: "We walked home.",
  forms: ["walked"],
  definition: "travel on foot",
  translation: "",
  phonetic: "",
  partOfSpeech: "verb",
  sourceTitle: "Test",
  sourceUrl: "https://example.com",
}

describe("Anki background lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.alarmListeners.length = 0
    mocks.startupListeners.length = 0
    mocks.installedListeners.length = 0
    setupAnkiMessageHandlers()
  })
  it("registers every local message and durable retry wake synchronously", () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      "ankiCleanupCet4",
      "ankiDeckNames",
      "ankiEnqueue",
      "ankiGetReviewStatus",
      "ankiGetSnapshot",
      "ankiRetry",
      "ankiSaveSettings",
    ])
    expect(mocks.createAlarm).toHaveBeenCalledWith(ANKI_RETRY_ALARM, { periodInMinutes: 1 })
    expect(mocks.processQueue).toHaveBeenCalledTimes(1)
    mocks.alarmListeners[0]!({ name: "unrelated" })
    expect(mocks.processQueue).toHaveBeenCalledTimes(1)
    mocks.alarmListeners[0]!({ name: ANKI_RETRY_ALARM })
    mocks.startupListeners[0]!()
    expect(mocks.processQueue).toHaveBeenCalledTimes(3)
  })
  it("runs cleanup only on its explicit message without changing routing settings", async () => {
    expect(mocks.cleanupCet4).not.toHaveBeenCalled()
    const result = await mocks.handlers.get("ankiCleanupCet4")!({})
    expect(result).toEqual({ moved: 1 })
    expect(mocks.cleanupCet4).toHaveBeenCalledOnce()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })
  it("routes statistics requests and invalidates counts when settings are saved", async () => {
    await mocks.handlers.get("ankiGetReviewStatus")!({ data: { force: true } })
    expect(mocks.getStatus).toHaveBeenCalledWith(true)
    await mocks.handlers.get("ankiSaveSettings")!({ data: {} })
    expect(mocks.invalidate).toHaveBeenCalledOnce()
  })
  it("persists a valid capture before kicking a network attempt", async () => {
    mocks.processQueue.mockClear()
    await mocks.handlers.get("ankiEnqueue")!({ data: { captures: [capture] } })
    expect(mocks.enqueue).toHaveBeenCalledWith([capture])
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processQueue.mock.invocationCallOrder[0]!,
    )
  })
  it("persists whole-phrase captures but refuses detached phrase parts", async () => {
    const phrase = {
      ...capture,
      term: "lock in",
      sentence: "We are locking in.",
      forms: ["locking in"],
    }
    await mocks.handlers.get("ankiEnqueue")!({ data: { captures: [phrase] } })
    expect(mocks.enqueue).toHaveBeenCalledWith([phrase])
    mocks.enqueue.mockClear()
    await expect(
      mocks.handlers.get("ankiEnqueue")!({
        data: { captures: [{ ...phrase, forms: ["locking", "in"] }] },
      }),
    ).rejects.toThrow("verified original form")
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("rejects malformed or oversized messages without persisting", async () => {
    await expect(mocks.handlers.get("ankiEnqueue")!({ data: { captures: [] } })).rejects.toThrow(
      "Save between",
    )
    await expect(
      mocks.handlers.get("ankiEnqueue")!({
        data: { captures: Array.from({ length: 21 }, () => capture) },
      }),
    ).rejects.toThrow("Save between")
    await expect(
      mocks.handlers.get("ankiEnqueue")!({
        data: { captures: [{ ...capture, sentence: "Not the word." }] },
      }),
    ).rejects.toThrow("valid target-word highlights")
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})

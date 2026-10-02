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
  retry: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ settings: {}, entries: [] }),
  invoke: vi.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue(["Read Frog"]),
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
      "ankiDeckNames",
      "ankiEnqueue",
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
  it("persists a valid capture before kicking a network attempt", async () => {
    mocks.processQueue.mockClear()
    await mocks.handlers.get("ankiEnqueue")!({ data: { captures: [capture] } })
    expect(mocks.enqueue).toHaveBeenCalledWith([capture])
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processQueue.mock.invocationCallOrder[0]!,
    )
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

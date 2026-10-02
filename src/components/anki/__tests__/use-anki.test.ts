// @vitest-environment jsdom
import type { AnkiCapture, AnkiEntry, AnkiSnapshot } from "@/utils/anki/types"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { normalizeCapture } from "@/utils/anki/normalization"
import { DEFAULT_ANKI_SETTINGS } from "@/utils/anki/types"
const mocks = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
const { useAnkiSnapshot, useSaveToAnki } = await import("../use-anki")
const capture: AnkiCapture = {
  term: "learn",
  sentence: "We learn every day.",
  forms: ["learn"],
  definition: "Gain knowledge",
  translation: "",
  phonetic: "",
  partOfSpeech: "verb",
  sourceTitle: "Original page",
  sourceUrl: "https://example.com/original",
}
function snapshot(status: AnkiEntry["status"] = "pending"): AnkiSnapshot {
  const normalized = normalizeCapture(capture)
  return {
    settings: { ...DEFAULT_ANKI_SETTINGS },
    entries: [
      {
        key: normalized.key,
        identity: normalized.identity,
        lemma: normalized.lemma,
        examples: [normalized.example],
        revision: 1,
        syncedRevision: status === "synced" ? 1 : 0,
        status,
        attempts: 0,
        nextRetryAt: 0,
        updatedAt: 1,
        deckName: "Read Frog",
      },
    ],
  }
}
describe("local Anki save hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it("persists before configuration and tracks a deduped sentence from another page", async () => {
    const saved = snapshot()
    mocks.send.mockResolvedValue(saved)
    const { result } = renderHook(() => useSaveToAnki())
    expect(mocks.send).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.save([{ ...capture, sourceUrl: "https://example.com/another" }])
    })
    expect(mocks.send).toHaveBeenCalledWith("ankiEnqueue", {
      captures: [{ ...capture, sourceUrl: "https://example.com/another" }],
    })
    await waitFor(() => expect(result.current.status).toBe("pending"))
    expect(result.current.snapshot?.settings.enabled).toBe(false)
  })
  it("ignores repeated clicks while an enqueue is in flight", async () => {
    let resolve!: (value: AnkiSnapshot) => void
    const deferred = new Promise<AnkiSnapshot>((done) => {
      resolve = done
    })
    mocks.send.mockImplementation((method: string) =>
      method === "ankiEnqueue" ? deferred : Promise.resolve(snapshot()),
    )
    const { result } = renderHook(() => useSaveToAnki())
    let first!: Promise<boolean>
    await act(async () => {
      first = result.current.save([capture])
      expect(await result.current.save([capture])).toBe(false)
    })
    expect(mocks.send.mock.calls.filter(([method]) => method === "ankiEnqueue")).toHaveLength(1)
    await act(async () => {
      resolve(snapshot())
      await first
    })
  })
  it("reports complete sync only from the background snapshot", async () => {
    mocks.send.mockResolvedValue(snapshot("synced"))
    const { result } = renderHook(() => useSaveToAnki())
    await act(async () => {
      await result.current.save([capture])
    })
    expect(result.current.status).toBe("synced")
  })
  it("stops polling after its surface unmounts", async () => {
    vi.useFakeTimers()
    mocks.send.mockResolvedValue(snapshot())
    const { unmount } = renderHook(() => useAnkiSnapshot())
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.send).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})

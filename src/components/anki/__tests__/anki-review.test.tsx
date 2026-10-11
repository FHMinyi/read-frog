// @vitest-environment jsdom
import type { AnkiReviewStatus } from "@/utils/anki/types"
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/utils/i18n"

const mocks = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
import { AnkiReviewEntry } from "../anki-review-entry"
import { useAnkiReview } from "../use-anki-review"

const ready: AnkiReviewStatus = {
  state: "ready",
  endpoint: "http://127.0.0.1:8765",
  deckName: "Read Frog",
  profileName: "Test",
  newCount: 10,
  learningCount: 3,
  reviewCount: 7,
  checkedAt: 1000,
}

beforeEach(() => {
  mocks.send.mockReset()
  mocks.send.mockResolvedValue(ready)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("Anki review entry", () => {
  it("shows the sum and deck breakdown as text without a review action", async () => {
    render(<AnkiReviewEntry />)
    const label = await screen.findByText(i18n.t("anki.reviewAvailable", [20]))
    expect(label).toHaveAttribute(
      "title",
      `Read Frog · ${i18n.t("anki.reviewBreakdown", [10, 3, 7])}`,
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    const requests = mocks.send.mock.calls.length
    fireEvent.click(label)
    expect(mocks.send).toHaveBeenCalledTimes(requests)
    expect(mocks.send.mock.calls.every(([action]) => action === "ankiGetReviewStatus")).toBe(true)
  })

  it.each(["disabled", "unavailable", "missing-deck"] as const)(
    "hides passive %s state in the popover",
    async (state) => {
      mocks.send.mockResolvedValue({ state, deckName: "Read Frog" })
      const { container } = render(<AnkiReviewEntry />)
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      expect(container).toBeEmptyDOMElement()
    },
  )

  it("shows zero and a manual refresh in options but hides zero in the popover", async () => {
    mocks.send.mockResolvedValue({ ...ready, newCount: 0, learningCount: 0, reviewCount: 0 })
    const { rerender, container } = render(<AnkiReviewEntry />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(container).toBeEmptyDOMElement()
    rerender(<AnkiReviewEntry detailed />)
    expect(await screen.findByText(i18n.t("anki.reviewEmpty"))).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.reviewRefresh") }))
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("ankiGetReviewStatus", { force: true }),
    )
  })
})

describe("review query lifecycle", () => {
  it("pauses hidden tabs and forces a fresh read when they become visible", async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    const { result } = renderHook(() => useAnkiReview())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(ready)
    visibility.mockReturnValue("hidden")
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    const count = mocks.send.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(mocks.send).toHaveBeenCalledTimes(count)
    expect(result.current.status).toBeNull()
    visibility.mockReturnValue("visible")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    expect(mocks.send).toHaveBeenLastCalledWith("ankiGetReviewStatus", { force: true })
    expect(result.current.status).toEqual(ready)
  })
  it("removes stale counts when connectivity is lost", async () => {
    const { result } = renderHook(() => useAnkiReview())
    await waitFor(() => expect(result.current.status?.state).toBe("ready"))
    mocks.send.mockRejectedValue(new Error("offline"))
    act(() => {
      result.current.refresh()
    })
    expect(result.current.status).toBeNull()
    await waitFor(() => expect(result.current.status?.state).toBe("unavailable"))
  })

  it("forces a refresh on return from Anki and stops when the popover closes", async () => {
    vi.useFakeTimers()
    const { result, rerender, unmount } = renderHook(({ active }) => useAnkiReview(active), {
      initialProps: { active: true },
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(ready)
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })
    expect(mocks.send).toHaveBeenLastCalledWith("ankiGetReviewStatus", { force: true })
    rerender({ active: false })
    const requests = mocks.send.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(mocks.send).toHaveBeenCalledTimes(requests)
    expect(result.current.status).toBeNull()
    unmount()
  })

  it("ignores a late response after the surface is deactivated", async () => {
    let finish!: (value: AnkiReviewStatus) => void
    mocks.send.mockReturnValue(
      new Promise<AnkiReviewStatus>((resolve) => {
        finish = resolve
      }),
    )
    const { result, rerender } = renderHook(({ active }) => useAnkiReview(active), {
      initialProps: { active: true },
    })
    rerender({ active: false })
    await act(async () => {
      finish(ready)
    })
    expect(result.current.status).toBeNull()
  })
})

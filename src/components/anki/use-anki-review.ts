import type { AnkiReviewStatus } from "@/utils/anki/types"
import { useCallback, useEffect, useState } from "react"
import { sendMessage } from "@/utils/message"

/** Only visible, mounted surfaces check connectivity; deck counts are cached in the worker. */
export function useAnkiReview(active = true) {
  const [status, setStatus] = useState<AnkiReviewStatus | null>(null)
  const [refreshId, setRefreshId] = useState(0)
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    setStatus(null)
  }
  const refresh = useCallback(() => {
    setStatus(null)
    setRefreshId((id) => id + 1)
  }, [])

  useEffect(() => {
    if (!active) return undefined
    const isVisible = () => document.visibilityState !== "hidden"
    let cancelled = false
    let busy = false
    let refreshAfterRequest = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (force = false) => {
      clearTimeout(timer)
      if (cancelled || !isVisible()) return
      if (busy) {
        refreshAfterRequest ||= force
        return
      }
      busy = true
      try {
        const next = await sendMessage("ankiGetReviewStatus", { force })
        if (!cancelled && isVisible() && !refreshAfterRequest) setStatus(next)
      } catch {
        if (!cancelled) setStatus({ state: "unavailable", deckName: "" })
      } finally {
        busy = false
        if (!cancelled) {
          if (refreshAfterRequest) {
            refreshAfterRequest = false
            void load(true)
          } else if (isVisible()) {
            timer = setTimeout(() => void load(), 15_000)
          }
        }
      }
    }
    const onFocus = () => {
      setStatus(null)
      void load(true)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      setStatus(null)
      if (document.visibilityState !== "hidden") void load(true)
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    void load(refreshId > 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active, refreshId])
  return { status: active ? status : null, refresh }
}

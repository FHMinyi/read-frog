import type { AnkiCapture, AnkiSnapshot } from "@/utils/anki/types"
import { useCallback, useEffect, useRef, useState } from "react"
import { normalizeCapture } from "@/utils/anki/normalization"
import { sendMessage } from "@/utils/message"

/** Poll only while a mounted surface has outstanding work; no account dependency. */
export function useAnkiSnapshot(active = true) {
  const [snapshot, setSnapshot] = useState<AnkiSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await sendMessage("ankiGetSnapshot", undefined)
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
      if (!cancelled) timer = setTimeout(() => void refresh(), 5000)
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active])
  return { snapshot, setSnapshot, error }
}

export function useSaveToAnki() {
  const [isSaving, setIsSaving] = useState(false)
  const [savedKeys, setSavedKeys] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const { snapshot, setSnapshot, error } = useAnkiSnapshot(savedKeys.length > 0)
  const save = useCallback(
    async (captures: AnkiCapture[]) => {
      if (savingRef.current || captures.length === 0) return false
      savingRef.current = true
      setIsSaving(true)
      setSaveError(null)
      try {
        const next = await sendMessage("ankiEnqueue", { captures })
        setSnapshot(next)
        setSavedKeys(captures.map((capture) => normalizeCapture(capture).key))
        return true
      } catch (caught) {
        setSaveError(caught instanceof Error ? caught.message : String(caught))
        return false
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    },
    [setSnapshot],
  )
  const entries = snapshot?.entries.filter((entry) => savedKeys.includes(entry.key)) ?? []
  const status = entries.some((entry) => entry.status === "error")
    ? "error"
    : entries.length > 0 && entries.every((entry) => entry.status === "synced")
      ? "synced"
      : savedKeys.length > 0
        ? "pending"
        : "idle"
  return {
    save,
    isSaving,
    status,
    snapshot,
    error: saveError ?? error ?? entries.find((entry) => entry.error)?.error,
  }
}

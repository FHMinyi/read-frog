import { browser } from "#imports"
import { validateAnkiCapture } from "@/utils/anki/capture"
import { createAnkiClient } from "@/utils/anki/client"
import { ankiEngine } from "@/utils/anki/engine"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"

export const ANKI_RETRY_ALARM = "read-frog-anki-retry"

/** Register synchronously so MV3 wake-up messages are never lost. */
export function setupAnkiMessageHandlers() {
  const drain = () => {
    void ankiEngine.processQueue().catch((error: unknown) => {
      // Individual entry errors are stored by the engine and shown in Options.
      logger.warn("[Anki] Could not process local queue", error)
    })
  }
  onMessage("ankiGetSnapshot", () => ankiEngine.getSnapshot())
  onMessage("ankiEnqueue", async ({ data }) => {
    if (!Array.isArray(data?.captures) || !data.captures.length || data.captures.length > 20) {
      throw new Error("Save between 1 and 20 words or phrases at a time.")
    }
    const snapshot = await ankiEngine.enqueue(data.captures.map(validateAnkiCapture))
    drain()
    return snapshot
  })
  onMessage("ankiSaveSettings", async ({ data }) => {
    const snapshot = await ankiEngine.updateSettings(data)
    drain()
    return snapshot
  })
  onMessage("ankiRetry", async () => {
    const snapshot = await ankiEngine.retry()
    drain()
    return snapshot
  })
  onMessage("ankiDeckNames", ({ data }) =>
    createAnkiClient(data.endpoint).invoke<string[]>("deckNames"),
  )
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ANKI_RETRY_ALARM) drain()
  })
  browser.runtime.onStartup.addListener(drain)
  browser.runtime.onInstalled.addListener(drain)
  // Recreate after every SW start: alarms may be cleared by browser updates.
  void browser.alarms.create(ANKI_RETRY_ALARM, { periodInMinutes: 1 }).catch((error: unknown) => {
    logger.warn("[Anki] Could not schedule queue retries", error)
  })
  drain()
}

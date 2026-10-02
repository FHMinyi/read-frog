import type { AnkiSynthesizer } from "../audio"
import type { AnkiMedia, AnkiStore } from "../store"
import { describe, expect, it, vi } from "vitest"
import { audioKey, getAnkiAudio } from "../audio"

function memoryMediaStore() {
  const cache = new Map<string, AnkiMedia>()
  return {
    getMedia: vi.fn<AnkiStore["getMedia"]>(async (key: string) => cache.get(key)),
    putMedia: vi.fn<AnkiStore["putMedia"]>(async (media) => {
      cache.set(media.key, media)
    }),
  } as unknown as AnkiStore
}

describe("persistent MP3 audio", () => {
  it("keys media by exact text and configured voice", () => {
    expect(audioKey("word", "en-US-AriaNeural")).not.toBe(audioKey("word", "en-US-GuyNeural"))
    expect(audioKey("word", "en-US-AriaNeural")).not.toBe(audioKey("Word", "en-US-AriaNeural"))
  })

  it("persists reusable MP3 bytes without requesting synthesis twice", async () => {
    const store = memoryMediaStore()
    const synthesize = vi.fn<AnkiSynthesizer>(async () => ({
      audio: new Uint8Array([0xff, 0xfb, 1, 2]).buffer,
      contentType: "audio/mpeg",
    }))
    const first = await getAnkiAudio(store, synthesize, "word", "en-US-AriaNeural")
    const second = await getAnkiAudio(store, synthesize, "word", "en-US-AriaNeural")
    expect(first).toEqual(second)
    expect(first.filename).toMatch(/^rf_[a-f0-9]{64}\.mp3$/)
    expect(atob(first.base64).charCodeAt(0)).toBe(255)
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it("rejects empty or non-MP3 responses rather than creating a silent card", async () => {
    const store = memoryMediaStore()
    await expect(
      getAnkiAudio(
        store,
        async () => ({ audio: new ArrayBuffer(0), contentType: "audio/mpeg" }),
        "word",
        "voice",
      ),
    ).rejects.toThrow("MP3")
    await expect(
      getAnkiAudio(
        store,
        async () => ({
          audio: new TextEncoder().encode("<html>error</html>").buffer,
          contentType: "audio/mpeg",
        }),
        "word",
        "voice",
      ),
    ).rejects.toThrow("MP3")
    expect(store.putMedia).not.toHaveBeenCalled()
  })
})

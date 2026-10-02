import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { synthesizeAnkiAudio } from "../audio"

/** Explicit opt-in: sends only these synthetic public fixtures to Microsoft Edge TTS. */
describe.skipIf(process.env.RUN_LIVE_ANKI_TTS !== "true")(
  "live built-in Edge TTS MP3 export",
  () => {
    it.each(["blossom", "The blossoms are beautiful."])(
      "exports MP3 bytes for %s",
      async (text) => {
        const result = await synthesizeAnkiAudio(text, "en-US-AriaNeural")
        expect(result.contentType).toMatch(/^audio\/(mpeg|mp3)/i)
        const bytes = new Uint8Array(result.audio)
        expect(bytes.length).toBeGreaterThan(1000)
        const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
        const mpeg = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
        expect(id3 || mpeg).toBe(true)
        if (process.env.ANKI_LIVE_AUDIO_DIR) {
          await mkdir(process.env.ANKI_LIVE_AUDIO_DIR, { recursive: true })
          await writeFile(
            join(process.env.ANKI_LIVE_AUDIO_DIR, text === "blossom" ? "word.mp3" : "sentence.mp3"),
            bytes,
          )
        }
      },
      90_000,
    )
  },
)

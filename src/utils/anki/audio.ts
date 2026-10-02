import type { AnkiMedia, AnkiStore } from "./store"
import { sha256 } from "js-sha256"

export type AnkiSynthesizer = (
  text: string,
  voice: string,
) => Promise<{ audio: ArrayBuffer; contentType: string }>
export const ANKI_AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3"

/** Exportable MP3 only. System speech has no portable media export and is never substituted. */
export const synthesizeAnkiAudio: AnkiSynthesizer = async (text, voice) => {
  const { synthesizeEdgeTTS } = await import("../server/edge-tts/api")
  const result = await synthesizeEdgeTTS({ text, voice, outputFormat: ANKI_AUDIO_FORMAT })
  if (!result.ok) throw new Error(`Edge TTS: ${result.error.message}`)
  return { audio: result.audio, contentType: result.contentType }
}

export function audioKey(text: string, voice: string): string {
  return sha256(JSON.stringify(["edge-tts", ANKI_AUDIO_FORMAT, voice, text]))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export async function getAnkiAudio(
  store: AnkiStore,
  synthesize: AnkiSynthesizer,
  text: string,
  voice: string,
  now: () => number = Date.now,
): Promise<AnkiMedia> {
  const key = audioKey(text, voice)
  const existing = await store.getMedia(key)
  if (existing) return existing
  const result = await synthesize(text, voice)
  const bytes = new Uint8Array(result.audio)
  const mp3 =
    bytes.length >= 3 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
  if (!mp3 || !/^audio\/(?:mpeg|mp3)(?:;|$)/i.test(result.contentType)) {
    throw new Error("Edge TTS did not return a usable MP3 file")
  }
  const media: AnkiMedia = {
    key,
    filename: `rf_${key}.mp3`,
    base64: toBase64(bytes),
    contentType: "audio/mpeg",
    createdAt: now(),
  }
  await store.putMedia(media)
  return media
}

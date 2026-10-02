import type { AnkiCapture } from "../types"
import { describe, expect, it } from "vitest"
import { normalizeCapture } from "../normalization"
const capture = (
  term: string,
  form: string,
  sentence = `They ${form} today.`,
  partOfSpeech = "verb",
): AnkiCapture => ({
  term,
  sentence,
  forms: [form],
  definition: "contextual meaning",
  translation: "",
  phonetic: "",
  partOfSpeech,
  sourceTitle: "Test",
  sourceUrl: "https://example.com",
})

describe("conservative contextual lemma identity", () => {
  it("merges ordinary and irregular inflections verified by the lexicon", () => {
    expect(normalizeCapture(capture("walk", "walked")).key).toBe(
      normalizeCapture(capture("walk", "walking")).key,
    )
    expect(normalizeCapture(capture("go", "went")).key).toBe(
      normalizeCapture(capture("go", "go")).key,
    )
    expect(
      normalizeCapture(capture("blossom", "blossoms", "The blossoms opened.", "noun")).lemma,
    ).toBe("blossom")
  })
  it("never merges derivations or unsupported AI lemma guesses", () => {
    const decision = normalizeCapture(capture("decide", "decision"))
    expect(decision.lemma).toBe("decision")
    expect(decision.key).not.toBe(normalizeCapture(capture("decide", "decided")).key)
    expect(normalizeCapture(capture("other", "xyzabc")).identity).toContain("uncertain:")
  })
  it("keeps unresolved homographs sentence-scoped but accepts contextual disambiguation", () => {
    expect(normalizeCapture(capture("saw", "saw", "I used a saw.", "noun")).key).not.toBe(
      normalizeCapture(capture("saw", "saw", "I saw a bird.", "verb")).key,
    )
    expect(normalizeCapture(capture("see", "saw", "I saw a bird.")).key).toBe(
      normalizeCapture(capture("see", "seeing")).key,
    )
  })
  it("preserves proper-name casing and keeps it distinct from common words", () => {
    const proper = normalizeCapture(capture("May", "May", "May arrived early.", "proper noun"))
    expect(proper.lemma).toBe("May")
    expect(proper.key).not.toBe(
      normalizeCapture(capture("may", "may", "They may arrive.", "verb")).key,
    )
  })
  it("deduplicates the same word+sentence regardless of source while keeping new sentences", () => {
    const original = capture("walk", "walked")
    expect(normalizeCapture(original).example.id).toBe(
      normalizeCapture({ ...original, sourceUrl: "https://example.org" }).example.id,
    )
    expect(normalizeCapture(original).example.id).not.toBe(
      normalizeCapture(capture("walk", "walked", "We walked home.")).example.id,
    )
  })
})

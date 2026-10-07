import type { AnkiCapture } from "../types"
import { describe, expect, it } from "vitest"
import { normalizeCapture } from "../normalization"
import { findSeparatedPhraseMatches } from "../phrases"
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

describe("whole-phrase contextual identity", () => {
  it.each(["lock in", "locked in", "locking in", "locks in"])(
    "merges verified first-word inflections as lock in: %s",
    (form) => {
      const value = normalizeCapture(capture("lock in", form))
      expect(value.lemma).toBe("lock in")
      expect(value.identity).toBe("phrase:lock in")
      expect(value.key).toBe(normalizeCapture(capture("lock in", "lock in")).key)
    },
  )

  it.each([
    ["take care of", "took care of"],
    ["give up", "given up"],
    ["carry on", "carried on"],
  ])("verifies irregular and longer contiguous phrases: %s", (term, form) => {
    expect(normalizeCapture(capture(term, form)).key).toBe(
      normalizeCapture(capture(term, term)).key,
    )
  })

  it("keeps phrases separate from their head word and other particles", () => {
    const value = normalizeCapture(capture("lock in", "locking in"))
    expect(value.key).not.toBe(normalizeCapture(capture("lock", "locking")).key)
    expect(value.key).not.toBe(normalizeCapture(capture("lock out", "locking out")).key)
    expect(normalizeCapture(capture(" LOCK   IN ", "Locking In")).key).toBe(value.key)
  })

  it.each([
    ["decide on", "decision on"],
    ["lock in", "locking out"],
    ["credit card", "credit cards"],
    ["inventedword in", "inventedwording in"],
  ])("does not guess unsupported or non-head phrase changes: %s", (term, form) => {
    const first = normalizeCapture(capture(term, form))
    const second = normalizeCapture(capture(term, form, `We used ${form} yesterday.`))
    expect(first.identity).toContain("uncertain-phrase:")
    expect(first.key).not.toBe(second.key)
    expect(first.key).not.toBe(normalizeCapture(capture(term, term)).key)
  })

  it("keeps ambiguous unchanged heads sentence-scoped without guessing a lemma", () => {
    expect(normalizeCapture(capture("saw off", "saw off")).key).not.toBe(
      normalizeCapture(capture("saw off", "saw off", "We saw off the branch.")).key,
    )
    expect(normalizeCapture(capture("see off", "saw off")).identity).toBe("phrase:see off")
  })

  it("deduplicates by the whole phrase and sentence without depending on the source", () => {
    const original = capture("lock in", "locking in")
    const first = normalizeCapture(original)
    expect(first.example.id).toBe(
      normalizeCapture({ ...original, sourceUrl: "https://another.example" }).example.id,
    )
    expect(first.example.id).not.toBe(normalizeCapture(capture("lock in", "locked in")).example.id)
  })
})

describe("separated phrases preserve whole-expression identity", () => {
  it.each([
    ["walk through", "She walked me through the guide.", "walking through"],
    ["lock in", "We lock it in.", "locking in"],
  ])("merges the supported gap with its contiguous forms: %s", (term, sentence, continuous) => {
    const match = findSeparatedPhraseMatches(sentence, term)[0]!
    const input = {
      ...capture(term, match.forms[0]!, sentence),
      forms: match.forms,
      phraseSpans: match.spans,
    }
    const result = normalizeCapture(input)
    expect(result.lemma).toBe(term)
    expect(result.identity).toBe(`phrase:${term}`)
    expect(result.key).toBe(normalizeCapture(capture(term, continuous)).key)
    expect(result.example.forms).toEqual(match.forms)
    expect(result.example.phraseSpans).toEqual(match.spans)
    expect(result.key).not.toBe(
      normalizeCapture(capture(term.split(" ")[0]!, match.forms[0]!, sentence)).key,
    )
    expect(result.example.id).toBe(
      normalizeCapture({ ...input, sourceUrl: "https://another.example" }).example.id,
    )
  })
})

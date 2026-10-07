import type { AnkiCapture, AnkiExample } from "./types"
import { sha256 } from "js-sha256"
import { normalizeSentenceWhitespace, validateAnkiCapture } from "./capture"
import { getInflectionLemmas } from "./inflections"
import { isAmbiguousPhraseForm, isVerifiedPhraseForm } from "./phrases"

export function normalizeWord(word: string): string {
  return word.normalize("NFKC").replaceAll("’", "'").trim().toLowerCase()
}

/**
 * The contextual dictionary proposes a lemma; licensed lexical inflection data
 * verifies the relationship. Never stem derivations (decision != decide).
 * An unresolved or conflicting relationship gets a sentence-scoped identity.
 */
export function normalizeCapture(input: AnkiCapture): {
  lemma: string
  identity: string
  key: string
  example: AnkiExample
} {
  const capture = validateAnkiCapture(input)
  const proposed = normalizeWord(capture.term)
  const phrase = capture.term.includes(" ")
  const forms = capture.phraseSpans
    ? [normalizeWord(capture.forms.join(" "))]
    : [...new Set(capture.forms.map(normalizeWord))]
  const form = forms[0]!
  const sentence = normalizeSentenceWhitespace(capture.sentence)
  const verified = forms.every((surface) =>
    phrase
      ? isVerifiedPhraseForm(proposed, surface)
      : surface === proposed || getInflectionLemmas(surface).includes(proposed),
  )
  // A term already presented in its surface form cannot resolve a lexical
  // homograph such as saw (tool / past of see). The contextual AI must supply
  // the canonical lemma, otherwise keep those captures separate.
  const ambiguous = forms.some((surface) =>
    phrase
      ? isAmbiguousPhraseForm(proposed, surface)
      : surface === proposed &&
        getInflectionLemmas(surface).some((candidate) => candidate !== proposed),
  )
  const properNoun = /\bproper\b/iu.test(capture.partOfSpeech)
  const lemma = verified ? (properNoun ? capture.term.normalize("NFKC").trim() : proposed) : form
  const identity =
    !verified || ambiguous
      ? `uncertain${phrase ? "-phrase" : ""}:${lemma}:${sha256(JSON.stringify([sentence, capture.partOfSpeech.toLowerCase()]))}`
      : properNoun
        ? `proper${phrase ? "-phrase" : ""}:${capture.term.normalize("NFKC").trim()}`
        : `${phrase ? "phrase" : "word"}:${lemma}`
  const key = `rfanki_${sha256(identity)}`
  return {
    lemma,
    identity,
    key,
    example: {
      ...capture,
      id: sha256(JSON.stringify([identity, sentence])),
    },
  }
}

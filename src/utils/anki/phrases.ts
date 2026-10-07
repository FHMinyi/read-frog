import type { AnkiTextSpan } from "./types"
import { getInflectionLemmas } from "./inflections"

/** Literal whole-expression matching, allowing only whitespace between parts. */
export function targetPattern(target: string): string {
  return target
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+")
}

function phraseParts(phrase: string): string[] {
  return phrase.normalize("NFKC").replaceAll("’", "'").trim().toLowerCase().split(/\s+/u)
}

/** Only the head may inflect; every remaining word must stay unchanged. */
export function isVerifiedPhraseForm(lemma: string, form: string): boolean {
  const proposed = phraseParts(lemma)
  const surface = phraseParts(form)
  return (
    proposed.length > 1 &&
    surface.length === proposed.length &&
    proposed.slice(1).every((part, index) => part === surface[index + 1]) &&
    (surface[0] === proposed[0] || getInflectionLemmas(surface[0]!).includes(proposed[0]!))
  )
}

export function isAmbiguousPhraseForm(lemma: string, form: string): boolean {
  const proposed = phraseParts(lemma)
  const surface = phraseParts(form)
  return (
    surface[0] === proposed[0] &&
    getInflectionLemmas(surface[0]!).some((candidate) => candidate !== proposed[0])
  )
}

/** No model call or suffix guessing: search actual contiguous, lexically verified spans. */
export function findPhraseForms(sentence: string, term: string): string[] {
  const parts = term.trim().split(/\s+/u)
  if (parts.length < 2) return []
  const head = `(?:${targetPattern(parts[0]!)}|[a-z]+(?:[-'’][a-z]+)*)`
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${head}\\s+${targetPattern(parts.slice(1).join(" "))}(?![\\p{L}\\p{N}_])`,
    "giu",
  )
  return [
    ...new Set(
      [...sentence.matchAll(pattern)]
        .map((match) => match[0])
        .filter((form) => isVerifiedPhraseForm(term, form)),
    ),
  ]
}

// Deliberately bounded: these supported expressions allow one object pronoun,
// not an arbitrary word sequence. Add new patterns only with their own cases.
const SEPARATED_PHRASES = new Set(["walk through", "lock in"])
const OBJECT_PRONOUN =
  "(?:me|you|him|her|it|us|them|myself|yourself|himself|herself|itself|ourselves|yourselves|themselves)"

export interface SeparatedPhraseMatch {
  forms: string[]
  spans: AnkiTextSpan[]
}

export function findSeparatedPhraseMatches(sentence: string, term: string): SeparatedPhraseMatch[] {
  const parts = phraseParts(term)
  if (!SEPARATED_PHRASES.has(parts.join(" "))) return []
  const head = `(?:${targetPattern(parts[0]!)}|[a-z]+(?:[-'’][a-z]+)*)`
  // Newlines and punctuation cannot act as a gap or connect different sentences.
  const space = "[^\\S\\r\\n\\v\\f\\u0085\\u2028\\u2029]+"
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${head})(${space}${OBJECT_PRONOUN}${space})(${targetPattern(parts[1]!)})(?![\\p{L}\\p{N}_])`,
    "giu",
  )
  return [...sentence.matchAll(pattern)].flatMap((match) => {
    const forms = [match[1]!, match[3]!]
    if (
      !isVerifiedPhraseForm(term, forms.join(" ")) ||
      isAmbiguousPhraseForm(term, forms.join(" "))
    )
      return []
    const start = match.index
    const tailStart = start + match[1]!.length + match[2]!.length
    return [
      {
        forms,
        spans: [
          { start, end: start + match[1]!.length },
          { start: tailStart, end: tailStart + match[3]!.length },
        ],
      },
    ]
  })
}

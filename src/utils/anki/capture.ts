import type { AnkiCapture, AnkiTextSpan } from "./types"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { findPhraseForms, findSeparatedPhraseMatches, targetPattern } from "./phrases"

export interface AnkiCaptureContext {
  /** Original paragraph snapshot used to generate this result. */
  sentence?: string
  sourceTitle?: string
  sourceUrl?: string
}

const MAX_SENTENCE_LENGTH = 12_000
const MAX_FIELD_LENGTH = 12_000

function plainString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function normalizeSentenceWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

export function containsWord(sentence: string, word: string): boolean {
  if (!word.trim()) return false
  const escaped = targetPattern(word)
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(sentence)
}

function parseForms(value: unknown): string[] {
  const raw = plainString(value)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item: unknown) => {
      if (item && typeof item === "object" && "text" in item) {
        const text = normalizeSentenceWhitespace(plainString(item.text))
        return text ? [text] : []
      }
      return []
    })
  } catch {
    return []
  }
}

const PHRASE_HIGHLIGHT_ERROR =
  "Anki needs a verified original form of this phrase. Longer, unsupported, or cross-sentence gaps are not supported."

const AMBIGUOUS_PHRASE_ERROR =
  "Anki found multiple possible phrase occurrences. Select a single sentence with one matching occurrence before saving."

interface PhraseHighlights {
  forms: string[]
  phraseSpans?: AnkiTextSpan[]
}

function phraseHighlights(sentence: string, term: string, annotations: string[]): PhraseHighlights {
  const separated = findSeparatedPhraseMatches(sentence, term)
  if (!separated.length) return { forms: phraseForms(sentence, term, annotations) }
  if (separated.length !== 1 || findPhraseForms(sentence, term).length) {
    throw new Error(AMBIGUOUS_PHRASE_ERROR)
  }
  const match = separated[0]!
  const quoted = normalizeSentenceWhitespace(annotations.join(" ")).toLowerCase()
  const joined = match.forms.join(" ").toLowerCase()
  const extent = normalizeSentenceWhitespace(
    sentence.slice(match.spans[0]!.start, match.spans[1]!.end),
  ).toLowerCase()
  if (quoted && quoted !== joined && quoted !== extent) throw new Error(PHRASE_HIGHLIGHT_ERROR)
  return { forms: match.forms, phraseSpans: match.spans }
}

/** Join annotated parts only when that exact contiguous span exists on the page. */
function phraseForms(sentence: string, term: string, annotations: string[]): string[] {
  if (!annotations.length) {
    const forms = findPhraseForms(sentence, term)
    if (!forms.length) throw new Error(PHRASE_HIGHLIGHT_ERROR)
    return forms
  }
  const width = term.split(/\s+/u).length
  const forms: string[] = []
  let parts: string[] = []
  let count = 0
  for (const annotation of annotations) {
    parts.push(annotation)
    count += annotation.split(/\s+/u).length
    if (count > width) throw new Error(PHRASE_HIGHLIGHT_ERROR)
    if (count === width) {
      const form = parts.join(" ")
      if (!containsWord(sentence, form)) throw new Error(PHRASE_HIGHLIGHT_ERROR)
      forms.push(form)
      parts = []
      count = 0
    }
  }
  if (count) throw new Error(PHRASE_HIGHLIGHT_ERROR)
  return forms
}

/** Stable field IDs, never localized labels or guessed field order. */
export function captureFromResult(
  action: SelectionToolbarCustomAction,
  result: Record<string, unknown>,
  context: AnkiCaptureContext = {},
): AnkiCapture {
  const get = (suffix: string) => {
    const field = action.outputSchema.find(
      (item) => item.id === `dictionary-${suffix}` || item.id.endsWith(`-dictionary-${suffix}`),
    )
    return field ? result[field.name] : undefined
  }
  const term = normalizeSentenceWhitespace(plainString(get("term")))
  const originalSource = context.sentence ?? ""
  const original = normalizeSentenceWhitespace(originalSource)
  const generatedSentence = normalizeSentenceWhitespace(plainString(get("context")))
  if (!term || !original) {
    throw new Error(
      "Anki needs a Dictionary result and the original sentence. Select a word in its sentence and try again.",
    )
  }
  if (term.length > 200) {
    throw new Error("Save a word or phrase of at most 200 characters to Anki.")
  }
  const phrase = /\s/u.test(term)
  if (generatedSentence && !original.includes(generatedSentence)) {
    throw new Error(
      "The generated sentence does not match the original page text. Run Dictionary again before saving.",
    )
  }
  const annotatedForms = parseForms(get("context-term"))
  let sentence = generatedSentence
  const sourceSegments = () => [
    ...new Intl.Segmenter("en", { granularity: "sentence" }).segment(originalSource),
  ]
  if (!sentence) {
    if (phrase) {
      const candidates = [
        ...new Intl.Segmenter("en", { granularity: "sentence" }).segment(original),
      ].flatMap((part) => {
        const text = normalizeSentenceWhitespace(part.segment)
        try {
          const highlights = phraseHighlights(text, term, annotatedForms)
          return [{ text, separated: Boolean(highlights.phraseSpans) }]
        } catch (error) {
          if (error instanceof Error && error.message === AMBIGUOUS_PHRASE_ERROR) throw error
          return []
        }
      })
      if (candidates.length > 1 && candidates.some((candidate) => candidate.separated)) {
        throw new Error(AMBIGUOUS_PHRASE_ERROR)
      }
      sentence = candidates[0]?.text ?? ""
    } else {
      sentence =
        [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(original)]
          .map((part) => part.segment.trim())
          .find((part) => [...annotatedForms, term].some((form) => containsWord(part, form))) ?? ""
    }
  }
  if (!sentence || sentence.length > MAX_SENTENCE_LENGTH) {
    if (phrase && !sentence) throw new Error(PHRASE_HIGHLIGHT_ERROR)
    throw new Error(
      "Anki needs an original sentence containing this word (maximum 12,000 characters).",
    )
  }
  let highlights: PhraseHighlights = phrase
    ? phraseHighlights(sentence, term, annotatedForms)
    : { forms: annotatedForms.length ? annotatedForms : [term] }
  if (highlights.phraseSpans) {
    const containing = sourceSegments().filter((part) =>
      normalizeSentenceWhitespace(part.segment).includes(sentence),
    )
    if (!containing.length) throw new Error(PHRASE_HIGHLIGHT_ERROR)
    if (containing.length !== 1) throw new Error(AMBIGUOUS_PHRASE_ERROR)
    if (!findSeparatedPhraseMatches(containing[0]!.segment, term).length)
      throw new Error(PHRASE_HIGHLIGHT_ERROR)
    // Preserve the complete source sentence even if a generated context was truncated.
    sentence = normalizeSentenceWhitespace(containing[0]!.segment)
    highlights = phraseHighlights(sentence, term, annotatedForms)
  }
  const { forms, phraseSpans } = highlights
  if (forms.some((form) => !containsWord(sentence, form))) {
    throw new Error(
      "The highlighted word is missing from the original sentence. Run Dictionary again before saving.",
    )
  }
  return validateAnkiCapture({
    term,
    sentence,
    forms,
    ...(phraseSpans ? { phraseSpans } : {}),
    definition: plainString(get("definition")),
    translation: plainString(get("context-translation")),
    phonetic: plainString(get("phonetic")),
    partOfSpeech: plainString(get("part-of-speech")),
    sourceTitle: context.sourceTitle ?? "",
    sourceUrl: context.sourceUrl ?? "",
  })
}

/** Validate again in the background; malformed runtime messages must not enter the queue. */
export function validateAnkiCapture(input: AnkiCapture): AnkiCapture {
  if (!input || typeof input !== "object") throw new Error("Invalid Anki capture.")
  const fields = [
    "term",
    "sentence",
    "definition",
    "translation",
    "phonetic",
    "partOfSpeech",
    "sourceTitle",
    "sourceUrl",
  ] as const
  for (const field of fields) {
    if (typeof input[field] !== "string" || input[field].length > MAX_FIELD_LENGTH) {
      throw new Error(`Invalid Anki ${field}.`)
    }
  }
  const term = normalizeSentenceWhitespace(input.term)
  if (!term || input.term.length > 200) {
    throw new Error("Anki requires a word or phrase (maximum 200 characters).")
  }
  const phraseWidth = term.split(/\s+/u).length
  if (
    !input.sentence.trim() ||
    input.sentence.length > MAX_SENTENCE_LENGTH ||
    !Array.isArray(input.forms) ||
    !input.forms.length ||
    input.forms.length > 20 ||
    input.forms.some(
      (form) =>
        typeof form !== "string" ||
        !form.trim() ||
        form.length > 200 ||
        !containsWord(input.sentence, form),
    )
  ) {
    throw new Error("Anki requires an original sentence with valid target-word highlights.")
  }
  let phraseSpans: AnkiTextSpan[] | undefined
  if (input.phraseSpans !== undefined) {
    const matches = findSeparatedPhraseMatches(input.sentence, term)
    const match = matches[0]
    if (
      phraseWidth !== 2 ||
      matches.length !== 1 ||
      !match ||
      findPhraseForms(input.sentence, term).length ||
      input.sentence !== input.sentence.trim() ||
      !Array.isArray(input.phraseSpans) ||
      input.phraseSpans.length !== 2 ||
      input.forms.length !== 2 ||
      input.forms.some((form, index) => form !== match.forms[index]) ||
      input.phraseSpans.some(
        (span, index) =>
          !span ||
          typeof span !== "object" ||
          !Number.isInteger(span.start) ||
          !Number.isInteger(span.end) ||
          span.start !== match.spans[index]!.start ||
          span.end !== match.spans[index]!.end,
      )
    ) {
      throw new Error("Anki phrase highlight spans do not match one verified original occurrence.")
    }
    phraseSpans = match.spans
  } else if (
    phraseWidth > 1 &&
    input.forms.some(
      (form) => normalizeSentenceWhitespace(form).split(/\s+/u).length !== phraseWidth,
    )
  ) {
    throw new Error(PHRASE_HIGHLIGHT_ERROR)
  }
  if (!input.definition.trim() && !input.translation.trim()) {
    throw new Error("Anki needs a contextual meaning or sentence translation before saving.")
  }
  return {
    ...input,
    term,
    sentence: input.sentence.trim(),
    forms: [...new Set(input.forms.map(normalizeSentenceWhitespace))],
    ...(phraseSpans ? { phraseSpans } : {}),
  }
}

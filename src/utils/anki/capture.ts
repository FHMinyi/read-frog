import type { AnkiCapture } from "./types"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"

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
  if (!word) return false
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(sentence)
}

function parseForms(value: unknown): string[] {
  const raw = plainString(value)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [
      ...new Set(
        parsed.flatMap((item: unknown) => {
          if (item && typeof item === "object" && "text" in item) {
            const text = plainString(item.text)
            return text ? [text] : []
          }
          return []
        }),
      ),
    ]
  } catch {
    return []
  }
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
  const term = plainString(get("term"))
  const original = normalizeSentenceWhitespace(context.sentence ?? "")
  const generatedSentence = normalizeSentenceWhitespace(plainString(get("context")))
  if (!term || !original) {
    throw new Error(
      "Anki needs a Dictionary result and the original sentence. Select a word in its sentence and try again.",
    )
  }
  if (term.length > 200 || /\s/u.test(term)) {
    throw new Error(
      "Save one word at a time to Anki. Multi-word expressions are not supported in this version.",
    )
  }
  if (generatedSentence && !original.includes(generatedSentence)) {
    throw new Error(
      "The generated sentence does not match the original page text. Run Dictionary again before saving.",
    )
  }
  const annotatedForms = parseForms(get("context-term"))
  let sentence = generatedSentence
  if (!sentence) {
    const segments = new Intl.Segmenter("en", { granularity: "sentence" }).segment(original)
    sentence =
      [...segments]
        .map((part) => part.segment.trim())
        .find((part) => [...annotatedForms, term].some((form) => containsWord(part, form))) ?? ""
  }
  if (!sentence || sentence.length > MAX_SENTENCE_LENGTH) {
    throw new Error(
      "Anki needs an original sentence containing this word (maximum 12,000 characters).",
    )
  }
  const forms = annotatedForms.length ? annotatedForms : [term]
  if (forms.some((form) => !containsWord(sentence, form))) {
    throw new Error(
      "The highlighted word is missing from the original sentence. Run Dictionary again before saving.",
    )
  }
  return validateAnkiCapture({
    term,
    sentence,
    forms,
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
  if (!input.term.trim() || input.term.length > 200 || /\s/u.test(input.term.trim())) {
    throw new Error("Anki requires a single word.")
  }
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
  if (!input.definition.trim() && !input.translation.trim()) {
    throw new Error("Anki needs a contextual meaning or sentence translation before saving.")
  }
  return {
    ...input,
    term: input.term.trim(),
    sentence: input.sentence.trim(),
    forms: [...new Set(input.forms)],
  }
}

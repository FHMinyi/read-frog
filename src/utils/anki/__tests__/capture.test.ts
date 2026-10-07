import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { describe, expect, it } from "vitest"
import { captureFromResult, containsWord, validateAnkiCapture } from "../capture"

const action = {
  outputSchema: [
    "term",
    "context",
    "context-term",
    "definition",
    "context-translation",
    "phonetic",
    "part-of-speech",
  ].map((suffix) => ({ id: `default-dictionary-${suffix}`, name: suffix, type: "string" })),
} as SelectionToolbarCustomAction
const result = {
  term: "blossom",
  context: "The blossoms are beautiful.",
  "context-term": '[{"text":"blossoms"}]',
  definition: "flowers",
  "context-translation": "花很美。",
}

describe("Anki original-source capture", () => {
  it("uses stable IDs and the original source snapshot", () => {
    const capture = captureFromResult(action, result, {
      sentence: "Spring has arrived. The blossoms are beautiful. Birds sing.",
      sourceTitle: "Spring",
      sourceUrl: "https://example.com/spring",
    })
    expect(capture.sentence).toBe("The blossoms are beautiful.")
    expect(capture.forms).toEqual(["blossoms"])
    expect(capture.sourceTitle).toBe("Spring")
  })
  it("rejects a hallucinated sentence or highlight", () => {
    expect(() => captureFromResult(action, result, { sentence: "A different page." })).toThrow(
      "does not match",
    )
    expect(() =>
      captureFromResult(
        action,
        { ...result, "context-term": '[{"text":"rose"}]' },
        { sentence: result.context },
      ),
    ).toThrow("highlighted word")
  })
  it("requires original context and meaning rather than guessing arbitrary schema fields", () => {
    expect(() => captureFromResult(action, result)).toThrow("original sentence")
    expect(() =>
      captureFromResult({ outputSchema: [] } as unknown as SelectionToolbarCustomAction, result, {
        sentence: result.context,
      }),
    ).toThrow("Dictionary")
    expect(() =>
      captureFromResult(
        action,
        { ...result, definition: "", "context-translation": "" },
        { sentence: result.context },
      ),
    ).toThrow("contextual meaning")
  })
  it("finds a source sentence when the model omits it", () => {
    expect(
      captureFromResult(
        action,
        { ...result, context: "" },
        { sentence: "Spring arrived. The blossoms are beautiful. Birds sing." },
      ).sentence,
    ).toBe(result.context)
  })
  it("matches whole words and safely escapes metacharacters", () => {
    expect(containsWord("The theater opened.", "the")).toBe(true)
    expect(containsWord("A theater opened.", "the")).toBe(false)
    expect(containsWord("Use C++ safely.", "C++")).toBe(true)
    expect(containsWord("A [tag] here", "[tag]")).toBe(true)
  })
})

const phraseSentence = "All right, we're locking in."
const phraseResult = {
  term: "lock in",
  context: phraseSentence,
  definition: "focus completely",
  "context-translation": "我们要全力以赴。",
}

describe("Anki contiguous phrase capture", () => {
  it.each(["", '[{"text":"locking in"}]', '[{"text":"locking"},{"text":"in"}]'])(
    "captures the complete surface phrase from the reported sentence: %s",
    (annotations) => {
      const capture = captureFromResult(
        action,
        { ...phraseResult, "context-term": annotations },
        {
          sentence: phraseSentence,
        },
      )
      expect(capture.term).toBe("lock in")
      expect(capture.forms).toEqual(["locking in"])
      expect(validateAnkiCapture(capture)).toEqual(capture)
    },
  )

  it("keeps repeated particles when joining multiple annotated occurrences", () => {
    const sentence = "We are locking in, and they locked in."
    const capture = captureFromResult(
      action,
      {
        ...phraseResult,
        context: sentence,
        "context-term": '[{"text":"locking"},{"text":"in"},{"text":"locked"},{"text":"in"}]',
      },
      { sentence },
    )
    expect(capture.forms).toEqual(["locking in", "locked in"])
  })

  it.each(["", '[{"text":"locking"},{"text":"in"}]'])(
    "finds the whole original phrase instead of an unrelated particle when context is omitted: %s",
    (annotations) => {
      const capture = captureFromResult(
        action,
        {
          ...phraseResult,
          context: "",
          "context-term": annotations,
        },
        { sentence: "We are in town. " + phraseSentence },
      )
      expect(capture.sentence).toBe(phraseSentence)
      expect(capture.forms).toEqual(["locking in"])
    },
  )

  it("normalizes phrase whitespace and case without losing the source form", () => {
    const sentence = "We are LOCKING\u00a0\u00a0IN."
    const capture = captureFromResult(
      action,
      {
        ...phraseResult,
        term: " LOCK   IN ",
        context: sentence,
      },
      { sentence },
    )
    expect(capture.term).toBe("LOCK IN")
    expect(capture.forms).toEqual(["LOCKING IN"])
    expect(containsWord(sentence, capture.forms[0]!)).toBe(true)
  })

  it.each([
    ["We lock the team in.", '[{"text":"lock"},{"text":"in"}]'],
    ["We lock it slowly in.", ""],
    ["We are locking inside.", ""],
    ["We are unlocking in town.", ""],
    [phraseSentence, '[{"text":"locking"}]'],
    [phraseSentence, '[{"text":"in"},{"text":"locking"}]'],
  ])("refuses incomplete, unsupported or substring matches: %s", (sentence, annotations) => {
    expect(() =>
      captureFromResult(
        action,
        {
          ...phraseResult,
          context: sentence,
          "context-term": annotations,
        },
        { sentence },
      ),
    ).toThrow("verified original form")
  })

  it("revalidates whole-phrase runtime messages and the term length limit", () => {
    const capture = captureFromResult(action, phraseResult, { sentence: phraseSentence })
    expect(() => validateAnkiCapture({ ...capture, forms: ["locking", "in"] })).toThrow(
      "verified original form",
    )
    expect(() => validateAnkiCapture({ ...capture, term: "a ".repeat(101) })).toThrow("200")
    expect(() =>
      captureFromResult(
        action,
        {
          ...phraseResult,
          context: "We locked in.",
        },
        { sentence: phraseSentence },
      ),
    ).toThrow("does not match")
  })
})

const walkedSentence =
  "walked me through emails that needed a reply, searching for relevant context in the background to help get things right."

describe("verified separated phrase capture", () => {
  it.each([
    "",
    '[{"text":"walked"},{"text":"through"}]',
    '[{"text":"walked through"}]',
    '[{"text":"walked me through"}]',
  ])("captures only the target spans in the screenshot sentence: %s", (annotations) => {
    const capture = captureFromResult(
      action,
      {
        term: "walk through",
        context: walkedSentence,
        definition: "guide someone through something",
        "context-term": annotations,
      },
      { sentence: walkedSentence },
    )
    expect(capture.sentence).toBe(walkedSentence)
    expect(capture.forms).toEqual(["walked", "through"])
    expect(capture.phraseSpans).toEqual([
      { start: 0, end: 6 },
      { start: 10, end: 17 },
    ])
    expect(validateAnkiCapture(capture)).toEqual(capture)
  })

  it.each([
    ["lock in", "We lock it in.", ["lock", "in"]],
    ["lock in", "They LOCKED THEM IN.", ["LOCKED", "IN"]],
    ["walk through", "She walks us through the plan.", ["walks", "through"]],
    ["walk through", "I walked myself through the checklist.", ["walked", "through"]],
  ])("finds one supported pronoun gap without extra model fields: %s", (term, sentence, forms) => {
    const capture = captureFromResult(
      action,
      { term, definition: "contextual meaning" },
      { sentence },
    )
    expect(capture.forms).toEqual(forms)
    expect(
      capture.phraseSpans!.map((span) => capture.sentence.slice(span.start, span.end)),
    ).toEqual(forms)
  })

  it("preserves a complete source sentence when generated context quotes only part of it", () => {
    const sentence = "She walked me through the plan, including the next steps."
    const capture = captureFromResult(
      action,
      { term: "walk through", context: "walked me through the plan", definition: "guide" },
      { sentence },
    )
    expect(capture.sentence).toBe(sentence)
    expect(
      capture.phraseSpans!.map((span) => capture.sentence.slice(span.start, span.end)),
    ).toEqual(["walked", "through"])
  })

  it.each([
    ["walk through", "She walked the team through the plan."],
    ["walk through", "She walked me slowly through the plan."],
    ["walk through", "She walked me, through the plan."],
    ["walk through", "She talked me through the plan."],
    ["walk through", "She walked me throughout the plan."],
    ["walk through", "She walked me. Through the plan."],
    ["walk through", "She walked me\nthrough the plan."],
    ["walk through", "She walked me\u2028through the plan."],
    ["walk through", "She walked me\u2029through the plan."],
    ["look up", "They looked it up."],
  ])("refuses unsupported, unverified or cross-boundary gaps: %s / %s", (term, sentence) => {
    expect(() =>
      captureFromResult(action, { term, context: sentence, definition: "meaning" }, { sentence }),
    ).toThrow("verified original form")
  })

  it.each([
    "She walked me through the plan and walked him through the notes.",
    "We walk through the plan, then walk her through the notes.",
    "She walked me through the plan. He walked us through the notes.",
  ])("refuses ambiguous occurrences rather than choosing an arbitrary match: %s", (sentence) => {
    expect(() =>
      captureFromResult(action, { term: "walk through", definition: "guide" }, { sentence }),
    ).toThrow("multiple possible")
  })

  it("verifies metadata again and refuses offset, term, form and source tampering", () => {
    const capture = captureFromResult(
      action,
      { term: "walk through", definition: "guide" },
      { sentence: walkedSentence },
    )
    expect(() =>
      validateAnkiCapture({
        ...capture,
        phraseSpans: [
          { start: 0, end: 6 },
          { start: 7, end: 9 },
        ],
      }),
    ).toThrow("phrase highlight spans")
    expect(() => validateAnkiCapture({ ...capture, term: "lock in" })).toThrow(
      "phrase highlight spans",
    )
    expect(() => validateAnkiCapture({ ...capture, forms: ["through", "walked"] })).toThrow(
      "phrase highlight spans",
    )
    expect(() =>
      validateAnkiCapture({ ...capture, sentence: walkedSentence.replace("me", "the team") }),
    ).toThrow("phrase highlight spans")
    expect(() =>
      validateAnkiCapture({ ...capture, sentence: walkedSentence.replace("me ", "me\u2028") }),
    ).toThrow("phrase highlight spans")
    expect(() => validateAnkiCapture({ ...capture, phraseSpans: null as never })).toThrow(
      "phrase highlight spans",
    )
  })

  it("retains existing contiguous phrase whitespace behavior", () => {
    const capture = captureFromResult(
      action,
      { term: "lock in", definition: "focus" },
      { sentence: "We lock\nin." },
    )
    expect(capture.forms).toEqual(["lock in"])
    expect(capture.phraseSpans).toBeUndefined()
  })
})

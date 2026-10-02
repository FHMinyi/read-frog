import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { describe, expect, it } from "vitest"
import { captureFromResult, containsWord } from "../capture"

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

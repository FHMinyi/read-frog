import type { AnkiEntry } from "../types"
import { describe, expect, it } from "vitest"
import { highlightSentence, renderAnkiFields } from "../render"

const filename = `rf_${"a".repeat(64)}.mp3`
function entry(): AnkiEntry {
  return {
    key: `rfanki_${"b".repeat(64)}`,
    lemma: "work",
    identity: "word:work",
    revision: 1,
    syncedRevision: 0,
    status: "pending",
    attempts: 0,
    nextRetryAt: 0,
    updatedAt: 0,
    deckName: "Read Frog",
    wordAudio: filename,
    examples: [
      {
        id: "one",
        term: "work",
        sentence: "She works & they work <outside>.",
        forms: ["work", "works"],
        definition: "perform an activity",
        translation: "他们工作。",
        phonetic: "/wɜːk/",
        partOfSpeech: "verb",
        sourceTitle: "Source",
        sourceUrl: "https://example.com/a?x=1&y=2",
        sentenceAudio: filename,
      },
    ],
  }
}

describe("portable Anki HTML", () => {
  it("shows only original sentences and their surface forms on the front", () => {
    const fields = renderAnkiFields(entry())
    expect(fields.Front).toBe(
      '<div class="rf-card"><p class="rf-sentence">She <mark>works</mark> &amp; they <mark>work</mark> &lt;outside&gt;.</p></div>',
    )
    expect(fields.Front).not.toContain("sound:")
    expect(fields.Front).not.toContain("perform")
    expect(fields.Back).toContain("perform an activity")
    expect(fields.Back).toContain("他们工作。")
    expect(fields.Back).toContain(`[sound:${filename}]`)
    expect(fields.Back).toContain('href="https://example.com/a?x=1&amp;y=2"')
  })

  it("escapes HTML, active source URLs and malicious sound directives", () => {
    const value = entry()
    value.lemma = '<img src=x onerror="alert(1)">'
    value.examples[0]!.definition = "<script>alert(1)</script>[sound:evil.mp3]"
    value.examples[0]!.sourceUrl = "javascript:alert(1)"
    value.examples[0]!.sourceTitle = "<img src=x>"
    value.examples[0]!.sentenceAudio = "evil.mp3]\n<script>"
    const fields = renderAnkiFields(value)
    expect(fields.Back).not.toContain("<script>")
    expect(fields.Back).not.toContain("<img")
    expect(fields.Back).not.toContain('href="javascript:')
    expect(fields.Back).not.toContain("[sound:evil.mp3]")
    expect(fields.Back).toContain("&#91;sound:evil.mp3&#93;")
  })

  it("does not match word substrings and safely treats regexp punctuation literally", () => {
    expect(highlightSentence("Work and homework, C++.", ["work", "C++"])).toBe(
      "<mark>Work</mark> and homework, <mark>C++</mark>.",
    )
    expect(highlightSentence("a+b and aaaab", ["a+b"])).toBe("<mark>a+b</mark> and aaaab")
  })
})

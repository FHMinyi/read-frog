import type { AnkiEntry } from "../types"
import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"
import { findSeparatedPhraseMatches } from "../phrases"
import { ANKI_TEMPLATE, highlightSentence, renderAnkiFields } from "../render"

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
    value.examples[0]!.sentence = "work <img src=x onerror=alert(1)>[sound:evil.mp3]"
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
  it("pairs every original sentence with its own definition, translation and audio", () => {
    const value = entry()
    const secondAudio = `rf_${"c".repeat(64)}.mp3`
    value.examples.push({
      ...value.examples[0]!,
      id: "two",
      sentence: "We worked together.",
      forms: ["worked"],
      definition: "do a job",
      translation: "我们一起工作过。",
      sentenceAudio: secondAudio,
    })
    const fields = renderAnkiFields(value)
    const dom = new JSDOM(fields.Back)
    const examples = dom.window.document.querySelectorAll(".rf-example")
    expect(examples).toHaveLength(2)
    expect(examples[0]!.querySelector(".rf-sentence")!.textContent).toBe(
      value.examples[0]!.sentence,
    )
    expect(examples[1]!.querySelector(".rf-sentence mark")!.textContent).toBe("worked")
    expect(examples[1]!.querySelector(".rf-definition")!.textContent).toBe("do a job")
    expect(examples[1]!.querySelector(".rf-translation")!.textContent).toBe("我们一起工作过。")
    expect(examples[0]!.querySelector(".rf-meta")!.textContent).toContain(`[sound:${filename}]`)
    expect(examples[1]!.querySelector(".rf-meta")!.textContent).toContain(`[sound:${secondAudio}]`)
    dom.window.close()
  })
  it.each([true, false])(
    "fills legacy originals without duplicating sentences (legacy: %s)",
    (legacy) => {
      const value = entry()
      value.examples.push({
        ...value.examples[0]!,
        id: "two",
        sentence: "We worked together.",
        forms: ["worked"],
        definition: "do a job",
        translation: "我们一起工作过。",
      })
      const fields = renderAnkiFields(value)
      const back = legacy
        ? fields.Back!.replace(/<p class="rf-sentence">.*?<\/p>/gs, "")
        : fields.Back!
      const html = ANKI_TEMPLATE.Back.replace("{{Back}}", () => back).replace(
        "{{Front}}",
        () => fields.Front!,
      )
      const dom = new JSDOM(html, { runScripts: "dangerously" })
      const document = dom.window.document
      const examples = document.querySelectorAll(".rf-example")
      expect(examples).toHaveLength(2)
      expect(document.querySelectorAll(".rf-sentence")).toHaveLength(2)
      expect(examples[0]!.querySelector(".rf-sentence")!.textContent).toBe(
        value.examples[0]!.sentence,
      )
      expect(examples[1]!.querySelector(".rf-sentence mark")!.textContent).toBe("worked")
      expect(examples[1]!.querySelector(".rf-definition")!.textContent).toBe("do a job")
      expect(document.querySelector("template")).toBeNull()
      dom.window.eval(document.querySelector("script")!.textContent)
      expect(document.querySelectorAll(".rf-sentence")).toHaveLength(2)
      dom.window.close()
    },
  )
  it("does not match word substrings and safely treats regexp punctuation literally", () => {
    expect(highlightSentence("Work and homework, C++.", ["work", "C++"])).toBe(
      "<mark>Work</mark> and homework, <mark>C++</mark>.",
    )
    expect(highlightSentence("a+b and aaaab", ["a+b"])).toBe("<mark>a+b</mark> and aaaab")
  })
  it("marks only the verified spans on both sides and preserves intervening and incidental words", () => {
    const sentence = "🧭 I walked home, then walked me through the guide and read through it."
    const match = findSeparatedPhraseMatches(sentence, "walk through")[0]!
    const value = entry()
    value.lemma = "walk through"
    value.identity = "phrase:walk through"
    value.examples[0] = {
      ...value.examples[0]!,
      term: "walk through",
      sentence,
      forms: match.forms,
      phraseSpans: match.spans,
    }
    const fields = renderAnkiFields(value)
    const expected =
      "🧭 I walked home, then <mark>walked</mark> me <mark>through</mark> the guide and read through it."
    expect(fields.Front).toContain(expected)
    expect(fields.Back).toContain(expected)
    expect(fields.Front!.match(/<mark>/g)).toHaveLength(2)
    expect(fields.Back!.match(/<mark>/g)).toHaveLength(2)
    expect(
      highlightSentence(
        "We lock it in. <img>[sound:evil.mp3]",
        ["lock", "in"],
        [
          { start: 3, end: 7 },
          { start: 11, end: 13 },
        ],
      ),
    ).toBe("We <mark>lock</mark> it <mark>in</mark>. &lt;img&gt;&#91;sound:evil.mp3&#93;")
    expect(() => highlightSentence(sentence, match.forms, [{ start: -1, end: 3 }])).toThrow(
      "Invalid Anki phrase highlight spans",
    )
  })

  it("highlights a whole continuous phrase on both sides without labeling its component words", () => {
    const value = entry()
    value.lemma = "lock in"
    value.identity = "phrase:lock in"
    value.examples[0]!.term = "lock in"
    value.examples[0]!.sentence = "All right, we're locking in."
    value.examples[0]!.forms = ["locking in"]
    const fields = renderAnkiFields(value)
    const expected = "All right, we&#39;re <mark>locking in</mark>."
    expect(fields.Front).toContain(expected)
    expect(fields.Back).toContain(expected)
    expect(fields.Back).toContain("lock in [sound:")
    expect(fields.Back).not.toContain("rf-badge")
    expect(
      highlightSentence("LOCKING\u00a0IN, not locking inside or unlocking in.", ["locking in"]),
    ).toBe("<mark>LOCKING\u00a0IN</mark>, not locking inside or unlocking in.")
    expect(highlightSentence("We lock it in.", ["lock in"])).toBe("We lock it in.")
  })
})

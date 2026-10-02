import type { AnkiEntry } from "./types"
import { getCetMembership } from "./cet"

export const ANKI_MODEL_NAME = "Read Frog Context v1"
export const ANKI_FIELDS = ["RFKey", "Front", "Back", "Data"] as const
export const ANKI_TEMPLATE = { Name: "Context", Front: "{{Front}}", Back: "{{Back}}" }
export const ANKI_CSS = `
.card { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 20px; line-height: 1.65; text-align: left; color: #21312b; background: #f6f8f5; }
.rf-card { max-width: 760px; margin: 0 auto; padding: 24px; }
.rf-sentence { margin: 0 0 1.1em; }
.rf-card mark { background: #d6efb4; color: #143713; border-radius: 3px; padding: 0 .12em; font-weight: 650; }
.rf-lemma { font-size: 1.6em; font-weight: 700; margin: 0; }
.rf-meta, .rf-source { font-size: .8em; opacity: .78; }
.rf-example { border-top: 1px solid #a5b6a5; padding-top: 16px; margin-top: 18px; }
.rf-badge { display: inline-block; border: 1px solid #75916d; border-radius: 6px; font-size: .7em; padding: 0 7px; margin-right: 5px; }
.rf-definition, .rf-translation { margin: .35em 0; white-space: pre-wrap; }
.rf-source a { color: inherit; overflow-wrap: anywhere; }
.card.nightMode, .card.night_mode, .nightMode .card, .night_mode .card { color: #e7eee4; background: #18221c; }
.nightMode .rf-card mark, .night_mode .rf-card mark { background: #3c572d; color: #efffe4; }
`

/** Brackets are escaped too: untrusted text must not inject Anki [sound:...] directives. */
export function escapeAnkiHtml(value: string): string {
  return value.replace(
    /[&<>"'[\]]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "[": "&#91;",
        "]": "&#93;",
      })[character]!,
  )
}

export function highlightSentence(sentence: string, forms: string[]): string {
  const alternatives = [...new Set(forms.filter((form) => form.trim()))]
    .sort((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (!alternatives.length) return escapeAnkiHtml(sentence)
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  )
  let output = ""
  let offset = 0
  for (const match of sentence.matchAll(pattern)) {
    output += escapeAnkiHtml(sentence.slice(offset, match.index))
    output += `<mark>${escapeAnkiHtml(match[0])}</mark>`
    offset = match.index + match[0].length
  }
  return output + escapeAnkiHtml(sentence.slice(offset))
}

function sound(filename: string | undefined): string {
  return filename && /^rf_[a-f0-9]{64}\.mp3$/.test(filename) ? `[sound:${filename}]` : ""
}

function source(title: string, href: string): string {
  const label = escapeAnkiHtml(title || href || "Unknown source")
  try {
    const url = new URL(href)
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
      return `<a href="${escapeAnkiHtml(url.href)}" rel="noreferrer noopener">${label}</a>`
    }
  } catch {
    // Invalid and active URLs are displayed as text, never links.
  }
  return label
}

/** Portable data lets another installation merge examples rather than erase them. */
export function encodeAnkiData(entry: AnkiEntry): string {
  return `rf1:${encodeURIComponent(
    JSON.stringify({
      version: 1,
      key: entry.key,
      lemma: entry.lemma,
      identity: entry.identity,
      examples: entry.examples,
      wordAudio: entry.wordAudio,
    }),
  )}`
}

export function renderAnkiFields(entry: AnkiEntry): Record<string, string> {
  const metadata = [
    ...new Set(
      entry.examples
        .map((example) => [example.phonetic, example.partOfSpeech].filter(Boolean).join(" · "))
        .filter(Boolean),
    ),
  ]
  const badges = getCetMembership(entry.lemma)
    .map((label) => `<span class="rf-badge">${escapeAnkiHtml(label)}</span>`)
    .join("")
  const front = entry.examples
    .map(
      (example) =>
        `<p class="rf-sentence">${highlightSentence(example.sentence, example.forms)}</p>`,
    )
    .join("")
  const back = entry.examples
    .map(
      (example, index) => `<section class="rf-example">
<div class="rf-meta">${index + 1}. ${sound(example.sentenceAudio)}</div>
<p class="rf-definition">${escapeAnkiHtml(example.definition)}</p>
<p class="rf-translation">${escapeAnkiHtml(example.translation)}</p>
<div class="rf-source">${source(example.sourceTitle, example.sourceUrl)}</div>
</section>`,
    )
    .join("")
  return {
    RFKey: entry.key,
    Front: `<div class="rf-card">${front}</div>`,
    Back: `<div class="rf-card"><div class="rf-lemma">${escapeAnkiHtml(entry.lemma)} ${sound(entry.wordAudio)}</div><div class="rf-meta">${metadata.map(escapeAnkiHtml).join("<br>")}</div>${badges}${back}</div>`,
    Data: encodeAnkiData(entry),
  }
}

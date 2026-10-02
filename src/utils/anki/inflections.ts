import inflectionData from "./data/inflections.tsv?raw"

let rows: readonly string[] | undefined

/**
 * Dictionary-backed candidates, never a context-free lemma decision.
 * Keep the unchanged input as a candidate: e.g. "saw" can be a noun or the
 * past tense of "see". No match is neutral and means coverage is unknown.
 */
export function getInflectionLemmas(form: string): readonly string[] {
  const word = form.trim().toLowerCase()
  if (!/^[a-z]+(?:[-'][a-z]+)*$/.test(word)) return []

  // Keep the on-disk format compact and only split it when actually needed.
  // A binary search avoids constructing tens of thousands of maps/arrays.
  rows ??= inflectionData.trimEnd().split("\n")
  let low = 0
  let high = rows.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const row = rows[mid]!
    const separator = row.indexOf("\t")
    const key = row.slice(0, separator)
    if (key === word) {
      return [word, ...row.slice(separator + 1).split(",")].sort()
    }
    if (key < word) low = mid + 1
    else high = mid - 1
  }
  return []
}

import cet4Data from "./data/cet4.txt?raw"
import cet6Data from "./data/cet6.txt?raw"

export type CetMembership = "CET4" | "CET6"

const cet4Words = new Set(cet4Data.trimEnd().split("\n"))
const cet6Words = new Set(cet6Data.trimEnd().split("\n"))

/**
 * Exact membership in the pinned ECDICT word lists, not a difficulty estimate.
 * The caller supplies the lemma. Inflections, punctuation and spelling variants
 * are not guessed here; unmatched headwords intentionally have no label.
 */
export function getCetMembership(lemma: string): CetMembership[] {
  const word = lemma.trim().toLowerCase()
  const result: CetMembership[] = []
  if (cet4Words.has(word)) result.push("CET4")
  if (cet6Words.has(word)) result.push("CET6")
  return result
}

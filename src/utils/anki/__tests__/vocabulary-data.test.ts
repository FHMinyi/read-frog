import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { getCetMembership } from "../cet"
import cet4Data from "../data/cet4.txt?raw"
import cet6Data from "../data/cet6.txt?raw"
import inflectionData from "../data/inflections.tsv?raw"
import manifest from "../data/manifest.json"
import { getInflectionLemmas } from "../inflections"

describe("pinned ECDICT extraction", () => {
  it("pins the audited upstream revision and license", () => {
    expect(manifest.source.revision).toBe("bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b")
    expect(manifest.source.sha256).toBe(
      "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf",
    )
    expect(manifest.source.license).toBe("MIT")
    expect(manifest.source.rows).toBe(770611)
    expect(manifest.counts).toEqual({
      cet4: 3849,
      cet6: 5407,
      overlap: 3451,
      inflectionForms: 56970,
      inflectionFormsWithMultipleLemmas: 231,
    })
  })

  it("verifies the exact vendored bytes and packaged license notice", () => {
    for (const [path, expected] of Object.entries(manifest.files)) {
      const content = readFileSync(new URL(`../../../../${path}`, import.meta.url))
      expect({
        path,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      }).toEqual({ path, ...expected })
    }
    const notice = readFileSync(
      new URL("../../../../public/licenses/anki-ecdict.txt", import.meta.url),
      "utf8",
    )
    const license = notice.slice(notice.indexOf("MIT License\n"))
    expect(createHash("sha256").update(license).digest("hex")).toBe(manifest.source.licenseSha256)
  })

  it("keeps lists complete, sorted, unique and independently labeled", () => {
    const cet4 = cet4Data.trimEnd().split("\n")
    const cet6 = cet6Data.trimEnd().split("\n")
    const cet6Set = new Set(cet6)
    expect(cet4).toHaveLength(3849)
    expect(cet6).toHaveLength(5407)
    expect(cet4.filter((word) => cet6Set.has(word))).toHaveLength(3451)
    for (const [words, label] of [
      [cet4, "CET4"],
      [cet6, "CET6"],
    ] as const) {
      expect(words).toEqual([...new Set(words)].sort())
      expect(words.filter((word) => word !== word.trim().toLowerCase())).toEqual([])
      expect(words.filter((word) => !getCetMembership(word).includes(label))).toEqual([])
    }
  })

  it("validates every inflection row and binary-search result", () => {
    const rows = inflectionData.trimEnd().split("\n")
    expect(rows).toHaveLength(manifest.counts.inflectionForms)
    const keys: string[] = []
    const errors: string[] = []
    for (const row of rows) {
      const [form, candidateText] = row.split("\t")
      if (!form || !candidateText) {
        errors.push(row)
        continue
      }
      keys.push(form)
      const candidates = candidateText.split(",")
      const expected = [...new Set([form, ...candidates])].sort()
      if (
        !expected.every((word) => /^[a-z]+(?:[-'][a-z]+)*$/.test(word)) ||
        candidates.includes(form) ||
        [...new Set(candidates)].sort().join(",") !== candidateText ||
        getInflectionLemmas(form).join(",") !== expected.join(",")
      )
        errors.push(form)
    }
    expect(keys).toEqual([...new Set(keys)].sort())
    expect(errors).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { getInflectionLemmas } from "../inflections"

describe("getInflectionLemmas", () => {
  it("uses dictionary-backed regular and irregular relationships", () => {
    expect(getInflectionLemmas("running")).toEqual(["run", "running"])
    expect(getInflectionLemmas("children")).toEqual(["child", "children"])
    expect(getInflectionLemmas("went")).toEqual(["go", "went"])
    expect(getInflectionLemmas("better")).toEqual(["better", "good"])
    expect(getInflectionLemmas("teeth")).toEqual(["teeth", "tooth"])
  })

  it("includes explicitly typed reverse-only relationships", () => {
    expect(getInflectionLemmas("were")).toEqual(["be", "were"])
  })

  it("preserves unchanged forms and all candidate lemmas without choosing a sense", () => {
    expect(getInflectionLemmas("saw")).toEqual(["saw", "see"])
    expect(getInflectionLemmas("left")).toEqual(["leave", "left"])
    expect(getInflectionLemmas("axes")).toEqual(["ax", "axe", "axes"])
    expect(getInflectionLemmas("found")).toEqual(["find", "found"])
  })

  it("normalizes only case and surrounding whitespace", () => {
    expect(getInflectionLemmas("  RUNNING\n")).toEqual(["run", "running"])
    expect(getInflectionLemmas("running!")).toEqual([])
    expect(getInflectionLemmas("running shoes")).toEqual([])
  })

  it("does not guess from suffixes or classify missing and non-ASCII forms", () => {
    for (const form of ["", " ", "inventedwording", "fictionalworded", "学习", "123"]) {
      expect(getInflectionLemmas(form)).toEqual([])
    }
  })

  it("does not let callers mutate cached dictionary candidates", () => {
    const candidates = getInflectionLemmas("saw") as string[]
    candidates.pop()
    expect(getInflectionLemmas("saw")).toEqual(["saw", "see"])
  })
})

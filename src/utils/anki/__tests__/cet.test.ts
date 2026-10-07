import { describe, expect, it } from "vitest"
import { getCetMembership } from "../cet"

describe("getCetMembership", () => {
  it("returns the exact independently tagged memberships in stable order", () => {
    expect(getCetMembership("ability")).toEqual(["CET4"])
    expect(getCetMembership("abolish")).toEqual(["CET6"])
    expect(getCetMembership("abandon")).toEqual(["CET4", "CET6"])
  })

  it("trims and ignores case without guessing a different headword", () => {
    expect(getCetMembership("  ABANDON\n")).toEqual(["CET4", "CET6"])
    expect(getCetMembership("I.E.")).toEqual(["CET4", "CET6"])
    expect(getCetMembership("abandon!")).toEqual([])
    expect(getCetMembership("abilities")).toEqual([])
    expect(getCetMembership("abandoning")).toEqual([])
    expect(getCetMembership("an ability")).toEqual([])
  })

  it("leaves unclassified, non-English and empty input neutral", () => {
    for (const word of ["", "  ", "not-a-real-headword-42", "学习", "!!!"]) {
      expect(getCetMembership(word)).toEqual([])
    }
  })

  it("returns a fresh result so a caller cannot change later memberships", () => {
    getCetMembership("abandon").pop()
    expect(getCetMembership("abandon")).toEqual(["CET4", "CET6"])
  })

  it("does not inherit component-word memberships for a phrase", () => {
    expect(getCetMembership("lock").length).toBeGreaterThan(0)
    expect(getCetMembership("lock in")).toEqual([])
    expect(getCetMembership("take care of")).toEqual([])
  })
})

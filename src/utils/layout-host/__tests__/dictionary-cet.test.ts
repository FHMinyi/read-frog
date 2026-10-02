import { describe, expect, it } from "vitest"
import { getCetMembership } from "@/utils/anki/cet"
import { withDictionaryCet } from "../dictionary-cet"
const schema = [
  { id: "default-dictionary-term", name: "Word", type: "string" as const, description: "" },
  { id: "default-dictionary-difficulty", name: "Level", type: "string" as const, description: "" },
]
describe("deterministic dictionary CET membership", () => {
  it("replaces any model-estimated proficiency with word-list memberships", () => {
    const input = { Word: "ability", Level: "C2" }
    expect(withDictionaryCet(schema, input).Level).toBe(getCetMembership("ability").join(" · "))
    expect(input.Level).toBe("C2")
  })
  it("does not invent labels for unknown words", () => {
    expect(withDictionaryCet(schema, { Word: "frogglezzzzz", Level: "A1" }).Level).toBe("")
  })
  it("clears estimated levels while the lemma is still streaming", () => {
    expect(withDictionaryCet(schema, { Level: "B2" }).Level).toBe("")
  })
  it("does not overwrite unrelated custom action fields", () => {
    const input = { Word: "ability", Level: "Important" }
    expect(withDictionaryCet([{ ...schema[0]!, id: "custom-word" }], input)).toBe(input)
  })
})

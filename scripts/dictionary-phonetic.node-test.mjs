import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { testSeries } from "../src/utils/config/__tests__/example/v087.ts"
import { migrate } from "../src/utils/config/migration-scripts/v087-to-v088.ts"
import { SUPPORTED_UI_LOCALES } from "../src/utils/i18n/locales.ts"

async function dictionaryContract(locale) {
  const text = await readFile(new URL(`../src/locales/${locale}.yml`, import.meta.url), "utf8")
  const block = text.split("        dictionary:\n")[1]?.split("        sentenceAnalysis:")[0]
  assert.ok(block, `missing Dictionary contract in ${locale}`)
  const rule = /^ {12}6\. (.*)$/m.exec(block)?.[1]
  const description = /^ {10}fieldPhoneticDescription: (.*)$/m.exec(block)?.[1]
  assert.ok(rule)
  assert.ok(description)
  // Oxfmt may choose single-quoted YAML instead of JSON-compatible double quotes.
  // Read only this one-line quoted scalar; no YAML dependency or model call is needed.
  const value = description.startsWith("'")
    ? description.slice(1, -1).replaceAll("''", "'")
    : JSON.parse(description)
  assert.ok(description.endsWith(description[0]))
  return { rule, description: value }
}

describe("Dictionary lemma pronunciation contract", () => {
  for (const locale of SUPPORTED_UI_LOCALES) {
    it(`keeps boxes → box pronunciation consistent in ${locale}`, async () => {
      const { rule, description } = await dictionaryContract(locale)
      assert.ok(rule.includes('Selection="boxes" → Term="box", Phonetic="/bɒks/".'))
      assert.ok(rule.startsWith(description), "prompt and field must give the same instruction")
      assert.ok(description.includes("Term"), "phonetic must refer to the returned Term")
      assert.ok(description.includes('""'), "unknown pronunciation must be left empty")
      assert.ok(!rule.includes("/bɒksiz/") && !rule.includes("/ˈbɒksɪz/"))
    })
  }

  it("explicitly separates normalized Term from selected inflection", async () => {
    const { description } = await dictionaryContract("en")
    assert.match(description, /returned normalized Term, not the selected inflected form/)
    assert.match(description, /pronunciation is unknown, return "" instead of guessing/)
  })
})

// Built-ins have read-time definitions since v088, so changing their current
// contract needs no new config migration. Keep the frozen legacy migration's
// distinction: untouched defaults become built-in state; user edits stay custom.
describe("legacy Dictionary upgrade preserves user instructions", () => {
  const fixture = testSeries["default-dictionary-wording"].config

  it("moves only the known untouched legacy default into code-owned state", () => {
    const input = structuredClone(fixture)
    const snapshot = structuredClone(input)
    const original = input.selectionToolbar.customActions.find((a) => a.id === "default-dictionary")
    assert.ok(original)
    const result = migrate(input)
    assert.equal(result.selectionToolbar.builtInActions.dictionary.providerId, original.providerId)
    assert.ok(!("systemPrompt" in result.selectionToolbar.builtInActions.dictionary))
    assert.ok(!result.selectionToolbar.customActions.some((a) => a.id === "default-dictionary"))
    assert.ok(
      !result.selectionToolbar.customActions.some((a) => a.systemPrompt === original.systemPrompt),
    )
    assert.deepEqual(input, snapshot)
    assert.deepEqual(migrate(result), result)
  })

  for (const changedField of ["systemPrompt", "prompt", "phoneticDescription"]) {
    it(`retains a user's ${changedField} edit rather than updating it as a default`, () => {
      const input = structuredClone(fixture)
      const action = input.selectionToolbar.customActions.find((a) => a.id === "default-dictionary")
      if (changedField === "phoneticDescription") {
        action.outputSchema.find((f) => f.id === "default-dictionary-phonetic").description =
          "My selected-form pronunciation rule"
      } else {
        action[changedField] += "\nMy pronunciation rule"
      }
      const edited = structuredClone(action)
      const snapshot = structuredClone(input)
      const result = migrate(input)
      const kept = result.selectionToolbar.customActions.find(
        (a) => a.id === "migrated-default-dictionary",
      )
      assert.ok(kept)
      assert.equal(kept.systemPrompt, edited.systemPrompt)
      assert.equal(kept.prompt, edited.prompt)
      assert.deepEqual(kept.outputSchema, edited.outputSchema)
      assert.deepEqual(input, snapshot)
      assert.deepEqual(migrate(result), result)
    })
  }
})

import type { SelectionToolbarCustomActionOutputField } from "@/types/config/selection-toolbar"
import { getCetMembership } from "@/utils/anki/cet"
import { getDictionarySlots } from "./slots"

/** A legacy difficulty field is a deterministic vocabulary-list label, never an AI estimate. */
export function withDictionaryCet<T extends Record<string, unknown>>(
  outputSchema: readonly SelectionToolbarCustomActionOutputField[],
  value: T,
): T {
  const slots = getDictionarySlots(outputSchema)
  if (!slots.term || !slots.difficulty) return value
  if (!(slots.term.name in value) && !(slots.difficulty.name in value)) return value
  const term = value[slots.term.name]
  return {
    ...value,
    [slots.difficulty.name]: typeof term === "string" ? getCetMembership(term).join(" · ") : "",
  }
}

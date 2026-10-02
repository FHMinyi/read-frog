// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { NoteSuggestionSessionResult } from "../use-note-suggestion"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"

const mocks = vi.hoisted(() => ({
  save: vi.fn<(...args: any[]) => any>(),
  toastAdd: vi.fn<(...args: any[]) => any>(),
  track: vi.fn<(...args: any[]) => any>(),
  state: {
    status: "idle",
    snapshot: null as { settings: { enabled: boolean }; entries?: unknown[] } | null,
    error: null,
  },
}))
vi.mock("@/components/anki/use-anki", () => ({
  useSaveToAnki: () => ({ save: mocks.save, isSaving: false, ...mocks.state }),
}))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: mocks.toastAdd } }))
vi.mock("@/utils/note-suggestion/analytics", () => ({
  trackNoteSuggestionEvent: (...args: unknown[]) => mocks.track(...args),
}))
vi.mock("@/utils/auth/auth-client", () => ({
  authClient: {
    useSession: () => {
      throw new Error("Anki must not request an official account")
    },
  },
}))
const { NoteSuggestionCard } = await import("../note-suggestion-card")

function createAction(): SelectionToolbarCustomAction {
  return {
    id: "save-action",
    name: "Dictionary",
    enabled: true,
    icon: "tabler:book-2",
    providerId: "test",
    systemPrompt: "system",
    prompt: "prompt",
    outputSchema: [
      ["term", "Term"],
      ["definition", "Definition"],
    ].map(([id, name]) => ({
      id: `dictionary-${id}`,
      name: name!,
      type: "string",
      description: "",
    })),
  }
}
const notes = [
  { Term: "ephemeral", Definition: "lasting a very short time" },
  { Term: "transient", Definition: "not permanent" },
]
function renderCard({
  deleted = false,
  changed = false,
}: { deleted?: boolean; changed?: boolean } = {}) {
  const actionSnapshot = createAction()
  const store = createStore()
  const config = structuredClone(DEFAULT_CONFIG)
  config.selectionToolbar.customActions = deleted
    ? []
    : [{ ...actionSnapshot, ...(changed ? { outputSchema: [], name: "New action" } : {}) }]
  store.set(configAtom, config)
  const suggestion: NoteSuggestionSessionResult = {
    sessionKey: "session-1",
    validated: { notes, summaryFieldName: "Definition" },
    actionSnapshot,
    captureContext: {
      sentence: "The ephemeral moment was transient.",
      sourceTitle: "Original page",
      sourceUrl: "https://example.com/original",
    },
    firedAt: 100,
    analyticsProvider: { provider: "openai", backend_kind: "llm" },
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return render(<NoteSuggestionCard suggestion={suggestion} markShownOnce={() => false} />, {
    wrapper,
  })
}
function clickSave() {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
}

describe("NoteSuggestionCard Anki save", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.save.mockResolvedValue(true)
    mocks.state.status = "idle"
    mocks.state.snapshot = null
  })
  it("queues only checked words with generation-time page and sentence snapshots without an account", async () => {
    renderCard()
    fireEvent.click(screen.getByRole("checkbox", { name: /transient not permanent/ }))
    clickSave()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save).toHaveBeenCalledWith([
      expect.objectContaining({
        term: "ephemeral",
        sentence: "The ephemeral moment was transient.",
        sourceTitle: "Original page",
        sourceUrl: "https://example.com/original",
      }),
    ])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: i18n.t("anki.pending") })).toBeDisabled(),
    )
  })
  it("disables saving when nothing is selected", () => {
    renderCard()
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox)
    expect(screen.getByRole("button", { name: i18n.t("anki.save") })).toBeDisabled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each([{ deleted: true }, { changed: true }])(
    "keeps the original schema when live action changes: %o",
    async (options) => {
      renderCard(options)
      clickSave()
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
      expect(mocks.save.mock.calls[0]?.[0]).toHaveLength(2)
      expect(mocks.toastAdd).not.toHaveBeenCalled()
    },
  )
  it("shows setup after local persistence with sync disabled", async () => {
    mocks.state.snapshot = { settings: { enabled: false }, entries: [] }
    renderCard()
    clickSave()
    await waitFor(() => expect(screen.getByText(i18n.t("anki.savedLocally"))).toBeVisible())
    expect(screen.getByRole("button", { name: i18n.t("anki.setup") })).toBeEnabled()
  })
  it("allows a retry after enqueue failed", async () => {
    mocks.save.mockResolvedValue(false)
    renderCard()
    clickSave()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: i18n.t("anki.save") })).toBeEnabled()
  })
})

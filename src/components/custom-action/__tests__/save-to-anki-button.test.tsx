// @vitest-environment jsdom
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/utils/i18n"
const mocks = vi.hoisted(() => ({
  save: vi.fn<(...args: any[]) => any>(),
  open: vi.fn<(...args: any[]) => any>(),
  state: {
    isSaving: false,
    status: "idle",
    snapshot: null as { settings: { enabled: boolean }; entries?: unknown[] } | null,
    error: null as string | null,
  },
}))
vi.mock("@/components/anki/use-anki", () => ({
  useSaveToAnki: () => ({ save: mocks.save, ...mocks.state }),
}))
vi.mock("@/utils/navigation", () => ({ openOptionsPage: mocks.open }))
vi.mock("@/utils/auth/auth-client", () => ({
  authClient: {
    useSession: () => {
      throw new Error("Account access is not needed")
    },
  },
}))
const { SaveToAnkiButton } = await import("../save-to-anki-button")
const action: SelectionToolbarCustomAction = {
  id: "dict",
  name: "Dictionary",
  icon: "book",
  providerId: "local",
  systemPrompt: "",
  prompt: "",
  outputSchema: [
    { id: "dictionary-term", name: "Word", type: "string", description: "" },
    { id: "dictionary-definition", name: "Definition", type: "string", description: "" },
  ],
}
function mount(isRunning = false) {
  render(
    <SaveToAnkiButton
      action={action}
      isRunning={isRunning}
      result={{ Word: "learn", Definition: "Gain knowledge" }}
      context={{
        sentence: "We learn every day.",
        sourceTitle: "Original",
        sourceUrl: "https://example.com/old",
      }}
    />,
  )
}
describe("SaveToAnkiButton", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { isSaving: false, status: "idle", snapshot: null, error: null }
    mocks.save.mockResolvedValue(true)
  })
  it("saves original source context with no official account gate", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith([
        expect.objectContaining({
          term: "learn",
          sentence: "We learn every day.",
          sourceTitle: "Original",
          sourceUrl: "https://example.com/old",
        }),
      ]),
    )
  })
  it("does not save a partial result", () => {
    mount(true)
    expect(screen.getByRole("button")).toBeDisabled()
  })
  it.each([
    ["pending", "pending"],
    ["error", "error"],
    ["synced", "synced"],
  ] as const)("shows %s queue state", (status, key) => {
    mocks.state.status = status
    mount()
    expect(screen.getByRole("button", { name: i18n.t(`anki.${key}`) })).toBeDisabled()
  })
  it("links to setup after the capture is safely queued", () => {
    mocks.state.status = "pending"
    mocks.state.snapshot = { settings: { enabled: false } }
    mount()
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("anki.savedLocally"))
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.setup") }))
    expect(mocks.open).toHaveBeenCalledWith({ route: "/anki" })
  })
  it("surfaces required audio failures without claiming sync", () => {
    mocks.state.status = "error"
    mocks.state.error = "Sentence audio failed"
    mount()
    expect(screen.getByRole("alert")).toHaveTextContent("Sentence audio failed")
    expect(screen.queryByText(i18n.t("anki.synced"))).not.toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { AnkiSnapshot } from "@/utils/anki/types"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_ANKI_SETTINGS } from "@/utils/anki/types"
import { i18n } from "@/utils/i18n"
const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: any[]) => any>(),
  setSnapshot: vi.fn<(...args: any[]) => any>(),
  snapshot: null as AnkiSnapshot | null,
}))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
vi.mock("@/components/anki/use-anki", () => ({
  useAnkiSnapshot: () => ({
    snapshot: mocks.snapshot,
    setSnapshot: mocks.setSnapshot,
    error: null,
  }),
}))
vi.mock("../../../components/page-layout", () => ({
  PageLayout: ({
    title,
    description,
    children,
  }: {
    title: ReactNode
    description: ReactNode
    children: ReactNode
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
}))
vi.mock("@/utils/auth/auth-client", () => ({
  authClient: {
    useSession: () => {
      throw new Error("Anki setup must not request an official account")
    },
  },
}))
const { AnkiPage } = await import("../index")
describe("Anki setup page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.snapshot = { settings: { ...DEFAULT_ANKI_SETTINGS }, entries: [] }
  })
  it("shows local defaults, no account requirement and required audio disclosure", () => {
    render(<AnkiPage />)
    expect(screen.getByLabelText(i18n.t("anki.endpoint"))).toHaveValue("http://127.0.0.1:8765")
    expect(screen.getByLabelText(i18n.t("anki.voice"))).toHaveValue("en-US-AriaNeural")
    expect(screen.getByText(i18n.t("anki.description"))).toBeVisible()
    expect(screen.getByText(i18n.t("anki.audioRequired"))).toBeVisible()
  })
  it("loads existing decks from the edited local endpoint", async () => {
    mocks.send.mockResolvedValue(["English", "Vocabulary"])
    render(<AnkiPage />)
    fireEvent.change(screen.getByLabelText(i18n.t("anki.endpoint")), {
      target: { value: "http://localhost:8765" },
    })
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.loadDecks") }))
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("ankiDeckNames", {
        endpoint: "http://localhost:8765",
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('option[value="English"]')).toBeInTheDocument(),
    )
  })
  it("enables sync on the first explicit save", async () => {
    mocks.send.mockResolvedValue({
      settings: { ...DEFAULT_ANKI_SETTINGS, enabled: true },
      entries: [],
    })
    render(<AnkiPage />)
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.saveAndEnable") }))
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("ankiSaveSettings", {
        ...DEFAULT_ANKI_SETTINGS,
        enabled: true,
      }),
    )
    expect(mocks.setSnapshot).toHaveBeenCalled()
  })
  it("surfaces connection failures without claiming setup is complete", async () => {
    mocks.send.mockRejectedValue(new Error("Open Anki Desktop and retry"))
    render(<AnkiPage />)
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.loadDecks") }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Open Anki Desktop and retry"),
    )
    expect(screen.queryByText(i18n.t("anki.connected"))).not.toBeInTheDocument()
  })
  it("pauses persisted settings without saving an unfinished endpoint edit", async () => {
    mocks.snapshot!.settings.enabled = true
    mocks.send.mockResolvedValue({
      ...mocks.snapshot!,
      settings: { ...DEFAULT_ANKI_SETTINGS, enabled: false },
    })
    render(<AnkiPage />)
    fireEvent.change(screen.getByLabelText(i18n.t("anki.endpoint")), {
      target: { value: "unfinished" },
    })
    fireEvent.click(screen.getByRole("switch"))
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("ankiSaveSettings", {
        ...DEFAULT_ANKI_SETTINGS,
        enabled: false,
      }),
    )
  })
})

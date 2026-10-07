// @vitest-environment jsdom
import type { NoteSuggestionSessionResult } from "../use-note-suggestion"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import type { AnkiSynthesizer } from "@/utils/anki/audio"
import type { AnkiClient } from "@/utils/anki/client"
import type { AnkiEngine } from "@/utils/anki/engine"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Dexie } from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { createStore, Provider } from "jotai"
import { afterEach, expect, it, vi } from "vitest"
import { ANKI_FIELDS, ANKI_MODEL_NAME, ANKI_TEMPLATE } from "@/utils/anki/render"
import { AnkiDatabase, createAnkiStore } from "@/utils/anki/store"
import { DEFAULT_ANKI_SETTINGS } from "@/utils/anki/types"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (message: { data: any }) => Promise<any>>(),
  engine: undefined as AnkiEngine | undefined,
  messages: [] as string[],
  toastAdd: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: { data: any }) => Promise<any>) => {
    bridge.handlers.set(name, handler)
  },
  sendMessage: async (name: string, data: unknown) => {
    bridge.messages.push(name)
    const handler = bridge.handlers.get(name)
    if (!handler) throw new Error(`Missing production background handler: ${name}`)
    return structuredClone(await handler(structuredClone({ data })))
  },
}))
vi.mock("@/utils/anki/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/anki/engine")>()
  return {
    ...actual,
    ankiEngine: {
      enqueue: (...args: Parameters<AnkiEngine["enqueue"]>) => bridge.engine!.enqueue(...args),
      getSnapshot: () => bridge.engine!.getSnapshot(),
      updateSettings: (...args: Parameters<AnkiEngine["updateSettings"]>) =>
        bridge.engine!.updateSettings(...args),
      retry: (...args: Parameters<AnkiEngine["retry"]>) => bridge.engine!.retry(...args),
      processQueue: () => bridge.engine!.processQueue(),
    },
  }
})
vi.mock("wxt/browser", () => ({
  browser: {
    alarms: {
      create: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      onAlarm: { addListener: vi.fn<(...args: unknown[]) => void>() },
    },
    runtime: {
      onStartup: { addListener: vi.fn<(...args: unknown[]) => void>() },
      onInstalled: { addListener: vi.fn<(...args: unknown[]) => void>() },
    },
  },
}))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: bridge.toastAdd } }))
vi.mock("@/utils/note-suggestion/analytics", () => ({
  trackNoteSuggestionEvent: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock("@/utils/auth/auth-client", () => ({
  authClient: {
    useSession: () => {
      throw new Error("Anki must not request an account")
    },
  },
}))

import { setupAnkiMessageHandlers } from "@/entrypoints/background/anki"
import { createAnkiEngine } from "@/utils/anki/engine"
import { NoteSuggestionCard } from "../note-suggestion-card"

Dexie.dependencies.indexedDB = indexedDB
Dexie.dependencies.IDBKeyRange = IDBKeyRange
let db: AnkiDatabase | undefined

afterEach(async () => {
  cleanup()
  if (bridge.engine) await bridge.engine.processQueue()
  if (db) await db.delete()
  bridge.handlers.clear()
  bridge.messages.length = 0
  bridge.toastAdd.mockClear()
  bridge.engine = undefined
})

it.each([
  {
    term: "ahead of the curve",
    definition: "领先于时代；超前",
    originalSentence:
      "Sometimes you have to invest ahead of the curve, but feedback is clear that you all want things to get simpler.",
    secondSentence: "Staying ahead of the curve takes careful planning.",
    forms: ["ahead of the curve"],
    spans: undefined,
    firstHtml: "invest <mark>ahead of the curve</mark>",
    secondHtml: "Staying <mark>ahead of the curve</mark>",
    unsupportedSentence: "Ahead of investing, the curve is steep.",
  },
  {
    term: "walk through",
    definition: "详细引导或带领某人了解，处理某事",
    originalSentence:
      "walked me through emails that needed a reply, searching for relevant context in the background to help get things right",
    secondSentence: "We walked through the instructions together.",
    forms: ["walked", "through"],
    spans: [
      { start: 0, end: 6 },
      { start: 10, end: 17 },
    ],
    firstHtml: "<mark>walked</mark> me <mark>through</mark> emails",
    secondHtml: "We <mark>walked through</mark> the instructions",
    unsupportedSentence: "She walked the whole team through the plan.",
  },
  {
    term: "lock in",
    definition: "确定；全力投入",
    originalSentence: "We lock it in.",
    secondSentence: "We are locking in today.",
    forms: ["lock", "in"],
    spans: [
      { start: 3, end: 7 },
      { start: 11, end: 13 },
    ],
    firstHtml: "We <mark>lock</mark> it <mark>in</mark>.",
    secondHtml: "We are <mark>locking in</mark> today.",
    unsupportedSentence: "We lock the whole team in.",
  },
])(
  "saves $term through the real UI, hook, background and sync engine as one reusable card",
  async ({
    term,
    definition,
    originalSentence,
    secondSentence,
    forms,
    spans,
    firstHtml,
    secondHtml,
    unsupportedSentence,
  }) => {
    const notes = new Map<
      number,
      {
        noteId: number
        modelName: string
        fields: Record<string, { value: string; order: number }>
      }
    >()
    const media = new Map<string, string>()
    const schedule = { due: 321, interval: 23, reps: 11 }
    const invoke = vi.fn<(action: string, params?: Record<string, any>) => Promise<unknown>>(
      async (action: string, params: Record<string, any> = {}): Promise<unknown> => {
        switch (action) {
          case "version":
            return 6
          case "modelNames":
            return [ANKI_MODEL_NAME]
          case "modelFieldNames":
            return [...ANKI_FIELDS]
          case "modelTemplates":
            return { Context: { Front: ANKI_TEMPLATE.Front, Back: ANKI_TEMPLATE.Back } }
          case "findNotes":
            return [...notes.values()]
              .filter((note) => params.query.includes(note.fields.RFKey!.value))
              .map((note) => note.noteId)
          case "notesInfo":
            return params.notes.map((id: number) => structuredClone(notes.get(id)))
          case "createDeck":
            return 1
          case "retrieveMediaFile":
            return media.get(params.filename) ?? false
          case "storeMediaFile":
            media.set(params.filename, params.data)
            return params.filename
          case "addNote": {
            if (params.note.options.allowDuplicate !== false)
              throw new Error("Duplicate prevention missing")
            const noteId = notes.size + 1
            notes.set(noteId, {
              noteId,
              modelName: params.note.modelName,
              fields: Object.fromEntries(
                Object.entries(params.note.fields).map(([name, value], order) => [
                  name,
                  { value: value as string, order },
                ]),
              ),
            })
            return noteId
          }
          case "updateNoteFields": {
            const note = notes.get(params.note.id)!
            for (const [name, value] of Object.entries(params.note.fields))
              note.fields[name]!.value = value as string
            return null
          }
          default:
            throw new Error(`Unexpected real transport or scheduling action: ${action}`)
        }
      },
    )
    db = new AnkiDatabase(`phrase-ui-integration-${term.replaceAll(" ", "-")}`)
    const store = createAnkiStore(db)
    await store.setSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true })
    const synthesize = vi.fn<AnkiSynthesizer>(async () => ({
      audio: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1]).buffer,
      contentType: "audio/mpeg",
    }))
    bridge.engine = createAnkiEngine({
      store,
      synthesize,
      createClient: () => ({ invoke }) as AnkiClient,
    })
    setupAnkiMessageHandlers()

    const action: SelectionToolbarCustomAction = {
      id: "phrase-integration",
      name: "Dictionary",
      enabled: true,
      icon: "tabler:book-2",
      providerId: "synthetic",
      systemPrompt: "",
      prompt: "",
      outputSchema: [
        { id: "dictionary-term", name: "Term", type: "string", description: "" },
        { id: "dictionary-definition", name: "Definition", type: "string", description: "" },
      ],
    }
    const atomStore = createStore()
    const config = structuredClone(DEFAULT_CONFIG)
    config.selectionToolbar.customActions = [action]
    atomStore.set(configAtom, config)
    function card(sentence: string) {
      const suggestion: NoteSuggestionSessionResult = {
        sessionKey: sentence,
        validated: {
          notes: [{ Term: term, Definition: definition }],
          summaryFieldName: "Definition",
        },
        actionSnapshot: action,
        captureContext: {
          sentence,
          sourceTitle: "Synthetic page",
          sourceUrl: "https://example.com/ahead",
        },
        firedAt: 1,
        analyticsProvider: { provider: "openai", backend_kind: "llm" },
      }
      return (
        <Provider store={atomStore}>
          <NoteSuggestionCard key={sentence} suggestion={suggestion} markShownOnce={() => false} />
        </Provider>
      )
    }
    const view = render(card(originalSentence))
    expect(screen.getByRole("checkbox", { name: new RegExp(term) })).toBeChecked()
    async function verifyLegacyWorkerRejection() {
      // A fixed content script talking to the previous worker shows the exact
      // inline error from the screenshot. Capture errors instead use a toast.
      const currentEnqueue = bridge.handlers.get("ankiEnqueue")!
      const legacyError =
        "Anki needs a contiguous original form of this phrase. Separated phrases are not supported; run Dictionary on a continuous expression before saving."
      bridge.handlers.set("ankiEnqueue", async ({ data }) => {
        expect(data.captures[0]).toMatchObject({
          term,
          sentence: originalSentence,
          forms,
          phraseSpans: spans,
        })
        throw new Error(legacyError)
      })
      fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(legacyError))
      expect(bridge.toastAdd).not.toHaveBeenCalled()
      expect(notes.size).toBe(0)
      expect(synthesize).not.toHaveBeenCalled()
      bridge.handlers.set("ankiEnqueue", currentEnqueue)
      bridge.messages.length = 0
    }
    if (spans) await verifyLegacyWorkerRejection()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
    await waitFor(() => expect(bridge.messages).toContain("ankiEnqueue"))
    await act(async () => {
      await bridge.engine!.processQueue()
    })
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: i18n.t("anki.save") })).not.toBeInTheDocument(),
    )
    expect(screen.queryByText("Anki requires a single word.")).not.toBeInTheDocument()
    const first = (await bridge.engine.getSnapshot()).entries[0]!
    expect(first).toMatchObject({
      lemma: term,
      identity: `phrase:${term}`,
      status: "synced",
    })
    expect(first.examples[0]!.forms).toEqual(forms)
    expect(first.examples[0]!.phraseSpans).toEqual(spans)
    expect(first.examples[0]!.sentence).toBe(originalSentence)

    view.rerender(card(secondSentence))
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
    await waitFor(() =>
      expect(bridge.messages.filter((name) => name === "ankiEnqueue")).toHaveLength(2),
    )
    await act(async () => {
      await bridge.engine!.processQueue()
    })
    const second = (await bridge.engine.getSnapshot()).entries[0]!
    expect(second.noteId).toBe(first.noteId)
    expect(second.examples).toHaveLength(2)
    expect(second.status).toBe("synced")
    expect(notes.size).toBe(1)
    expect(invoke.mock.calls.filter(([name]) => name === "addNote")).toHaveLength(1)
    expect(invoke.mock.calls.filter(([name]) => name === "updateNoteFields")).toHaveLength(1)
    expect(schedule).toEqual({ due: 321, interval: 23, reps: 11 })
    expect(synthesize.mock.calls).toHaveLength(3)
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual([
      term,
      originalSentence,
      secondSentence,
    ])
    expect(media.size).toBe(3)
    const fields = [...notes.values()][0]!.fields
    expect(fields.Front!.value).toContain(firstHtml)
    expect(fields.Front!.value).toContain(secondHtml)
    expect(fields.Back!.value).toContain(firstHtml)
    expect(fields.Back!.value).toContain(secondHtml)
    expect(fields.Back!.value).toContain(definition)
    expect(fields.Back!.value).toContain("[sound:rf_")
    expect(fields.Back!.value).not.toContain("rf-badge")
    view.rerender(card(unsupportedSentence))
    fireEvent.click(screen.getByRole("button", { name: i18n.t("anki.save") }))
    await waitFor(() => expect(bridge.toastAdd).toHaveBeenCalledTimes(1))
    expect(bridge.messages.filter((name) => name === "ankiEnqueue")).toHaveLength(2)
    expect(notes.size).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(3)
  },
)

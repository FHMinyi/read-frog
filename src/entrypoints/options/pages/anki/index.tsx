import type { AnkiSettings } from "@/utils/anki/types"
import { useState } from "react"
import { useAnkiSnapshot } from "@/components/anki/use-anki"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { Label } from "@/components/ui/base-ui/label"
import { Switch } from "@/components/ui/base-ui/switch"
import { DEFAULT_ANKI_SETTINGS } from "@/utils/anki/types"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { PageLayout } from "../../components/page-layout"

export function AnkiPage() {
  const { snapshot, setSnapshot, error: loadError } = useAnkiSnapshot()
  const [settings, setSettings] = useState<AnkiSettings | null>(null)
  const [decks, setDecks] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const draft = settings ?? snapshot?.settings ?? DEFAULT_ANKI_SETTINGS
  const patch = (next: Partial<AnkiSettings>) =>
    setSettings((current) => ({ ...(current ?? draft), ...next }))
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const entries = snapshot?.entries ?? []
  return (
    <PageLayout
      title={i18n.t("anki.title")}
      description={i18n.t("anki.description")}
      innerClassName="flex max-w-3xl flex-col gap-6"
    >
      <section id="anki-setup" className="space-y-3 rounded-xl border bg-muted/30 p-5">
        <h2 className="font-semibold">{i18n.t("anki.setup")}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>{i18n.t("anki.setupAnki")}</li>
          <li>{i18n.t("anki.setupConnect")}</li>
          <li>{i18n.t("anki.setupDeck")}</li>
        </ol>
        <p className="text-sm">{i18n.t("anki.audioRequired")}</p>
      </section>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            const next = await sendMessage("ankiSaveSettings", {
              ...draft,
              enabled: true,
              endpoint: draft.endpoint.trim(),
              deckName: draft.deckName.trim(),
              voice: draft.voice.trim(),
            })
            setSnapshot(next)
            setSettings(next.settings)
            setNotice(i18n.t("anki.settingsSaved"))
          })
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="anki-endpoint">{i18n.t("anki.endpoint")}</Label>
          <Input
            id="anki-endpoint"
            required
            value={draft.endpoint}
            onChange={(event) => patch({ endpoint: event.target.value })}
            placeholder="http://127.0.0.1:8765"
          />
          <p className="text-xs text-muted-foreground">{i18n.t("anki.localOnly")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="anki-deck">{i18n.t("anki.deck")}</Label>
          <div className="flex gap-2">
            <Input
              id="anki-deck"
              list="anki-decks"
              required
              value={draft.deckName}
              onChange={(event) => patch({ deckName: event.target.value })}
            />
            <datalist id="anki-decks">
              {decks.map((deck) => (
                <option key={deck} value={deck} />
              ))}
            </datalist>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const names = await sendMessage("ankiDeckNames", {
                    endpoint: draft.endpoint.trim(),
                  })
                  setDecks(names)
                  setNotice(i18n.t("anki.connected"))
                })
              }
            >
              {i18n.t("anki.loadDecks")}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="anki-voice">{i18n.t("anki.voice")}</Label>
          <Input
            id="anki-voice"
            required
            value={draft.voice}
            onChange={(event) => patch({ voice: event.target.value })}
            placeholder="en-US-AriaNeural"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="anki-enabled">{i18n.t("anki.enable")}</Label>
          <Switch
            id="anki-enabled"
            checked={draft.enabled}
            disabled={busy || !snapshot?.settings.enabled}
            onCheckedChange={(enabled) => {
              patch({ enabled })
              void run(async () => {
                const next = await sendMessage("ankiSaveSettings", {
                  ...(snapshot?.settings ?? draft),
                  enabled,
                })
                setSnapshot(next)
                setSettings(next.settings)
              })
            }}
          />
        </div>
        <Button type="submit" disabled={busy || !snapshot}>
          {i18n.t("anki.saveAndEnable")}
        </Button>
      </form>
      {(error || loadError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? loadError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <section className="space-y-3 border-t pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{i18n.t("anki.queue")}</h2>
          <Button
            variant="outline"
            disabled={busy || !draft.enabled}
            onClick={() =>
              void run(async () => {
                setSnapshot(await sendMessage("ankiRetry", undefined))
              })
            }
          >
            {i18n.t("anki.retry")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{i18n.t("anki.queueDescription")}</p>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{i18n.t("anki.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border px-4">
            {[...entries]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((entry) => (
                <li key={entry.key} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{entry.lemma}</p>
                    <p className="truncate text-xs text-muted-foreground">{entry.deckName}</p>
                    {entry.error && (
                      <p className="text-xs break-words text-destructive">{entry.error}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs" role="status">
                    {entry.status === "synced"
                      ? i18n.t("anki.synced")
                      : entry.status === "error"
                        ? i18n.t("anki.error")
                        : entry.status === "syncing"
                          ? i18n.t("anki.syncing")
                          : i18n.t("anki.pending")}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </PageLayout>
  )
}

import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { IconBookmarkPlus } from "@tabler/icons-react"
import { useState } from "react"
import { useSaveToAnki } from "@/components/anki/use-anki"
import { Button } from "@/components/ui/base-ui/button"
import { SELECTION_TOOLBAR_FOOTER_COMPACT_CLASSES } from "@/components/ui/selection-popover/selection-toolbar-footer-compact"
import { captureFromResult } from "@/utils/anki/capture"
import { i18n } from "@/utils/i18n"
import { openOptionsPage } from "@/utils/navigation"
import { cn } from "@/utils/styles/utils"

interface SaveToAnkiButtonProps {
  action: SelectionToolbarCustomAction
  isRunning: boolean
  result: Record<string, unknown> | null
  context: { sentence?: string; sourceTitle?: string; sourceUrl?: string }
}

export function SaveToAnkiButton(props: SaveToAnkiButtonProps) {
  // A new generated result is a new save interaction; live page navigation is
  // deliberately absent because context belongs to the generation snapshot.
  const identity = JSON.stringify([props.action.outputSchema, props.result, props.context])
  return <SaveToAnkiResultButton key={identity} {...props} />
}

function SaveToAnkiResultButton({ action, isRunning, result, context }: SaveToAnkiButtonProps) {
  const { save, isSaving, status, snapshot, error } = useSaveToAnki()
  const [captureError, setCaptureError] = useState<string | null>(null)
  const handleClick = async () => {
    if (!result) return
    setCaptureError(null)
    try {
      await save([captureFromResult(action, result, context)])
    } catch (caught) {
      setCaptureError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  const label = isSaving
    ? i18n.t("anki.saving")
    : status === "synced"
      ? i18n.t("anki.synced")
      : status === "pending"
        ? i18n.t("anki.pending")
        : status === "error"
          ? i18n.t("anki.error")
          : i18n.t("anki.save")
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          type="button"
          variant="brand"
          size="sm"
          className={cn("min-w-0 shrink", SELECTION_TOOLBAR_FOOTER_COMPACT_CLASSES.button)}
          title={label}
          disabled={isRunning || !result || isSaving || status !== "idle"}
          onClick={() => void handleClick()}
        >
          <IconBookmarkPlus className={SELECTION_TOOLBAR_FOOTER_COMPACT_CLASSES.icon} />
          <span className={cn("truncate", SELECTION_TOOLBAR_FOOTER_COMPACT_CLASSES.label)}>
            {label}
          </span>
        </Button>
        {snapshot && (!snapshot.settings.enabled || status === "error") && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void openOptionsPage({ route: "/anki" })}
          >
            {i18n.t("anki.setup")}
          </Button>
        )}
      </div>
      {(captureError || error) && (
        <span role="alert" className="max-w-72 text-xs text-destructive">
          {captureError ?? error}
        </span>
      )}
      {snapshot && !snapshot.settings.enabled && (
        <span role="status" className="text-xs text-muted-foreground">
          {i18n.t("anki.savedLocally")}
        </span>
      )}
    </div>
  )
}

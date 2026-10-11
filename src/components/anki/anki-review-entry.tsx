import { Button } from "@/components/ui/base-ui/button"
import { i18n } from "@/utils/i18n"
import { cn } from "@/utils/styles/utils"
import { useAnkiReview } from "./use-anki-review"

export function AnkiReviewEntry({ active = true, detailed = false }) {
  const { status, refresh } = useAnkiReview(active)
  const ready = status?.state === "ready" ? status : null
  const count = ready ? ready.newCount + ready.learningCount + ready.reviewCount : 0
  const breakdown = ready
    ? i18n.t("anki.reviewBreakdown", [ready.newCount, ready.learningCount, ready.reviewCount])
    : ""

  if (!active || (!detailed && count === 0)) return null

  return (
    <div className={cn("flex flex-col gap-1 text-xs", !detailed && "max-w-80 self-end px-3 py-1")}>
      {detailed && (
        <>
          <span className="font-medium">{i18n.t("anki.reviewTitle")}</span>
          <span role="status" className="text-muted-foreground">
            {!status
              ? i18n.t("anki.reviewLoading")
              : status.state === "disabled"
                ? i18n.t("anki.reviewDisabled")
                : status.state === "missing-deck"
                  ? i18n.t("anki.reviewMissingDeck", [status.deckName])
                  : status.state === "unavailable"
                    ? i18n.t("anki.reviewUnavailable")
                    : `${status.deckName} · ${breakdown}`}
          </span>
        </>
      )}
      <div className="flex items-center gap-2">
        {ready && count > 0 && (
          <span
            title={`${ready.deckName} · ${breakdown}`}
            className="px-2 py-1 text-muted-foreground"
          >
            {i18n.t("anki.reviewAvailable", [count])}
          </span>
        )}
        {detailed && ready && count === 0 && <span>{i18n.t("anki.reviewEmpty")}</span>}
        {detailed && (
          <Button type="button" size="sm" variant="ghost" onClick={refresh}>
            {i18n.t("anki.reviewRefresh")}
          </Button>
        )}
      </div>
    </div>
  )
}

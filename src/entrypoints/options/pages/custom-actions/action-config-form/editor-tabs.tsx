import type { CustomActionEditorTab } from "@/utils/navigation"
import { useSelector } from "@tanstack/react-store"
import { useAtom } from "jotai"
import { useRef } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/base-ui/tabs"
import { i18n } from "@/utils/i18n"
import { CUSTOM_ACTION_NOTEBASE_SECTION_ID } from "@/utils/navigation"
import { cn } from "@/utils/styles/utils"
import { customActionEditorTabAtom } from "../atoms"
import { useActionEditor } from "./action-editor"

type TabsKey = "config" | "notebase" | "hasErrors" | "connected" | "needsAttention"

function t(key: TabsKey) {
  return i18n.t(`options.selectionToolbar.customActions.tabs.${key}`)
}

// Clears the narrow-width sticky top bar (h-12) when a tab or the bar is scrolled to.
const SCROLL_MARGIN = "scroll-mt-14 md:scroll-mt-4"

function StatusDot({ tone, label }: { tone: "neutral" | "destructive"; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "destructive" ? "bg-destructive" : "bg-muted-foreground/70",
      )}
    />
  )
}

function ConfigTabStatus() {
  const { form } = useActionEditor().state
  // Mapping problems belong to the Notebase tab's own dot.
  const hasErrors = useSelector(form.store, (state) =>
    Object.entries(state.fieldMeta).some(
      ([name, meta]) => !name.startsWith("notebaseConnection") && (meta?.errors.length ?? 0) > 0,
    ),
  )
  return hasErrors ? <StatusDot tone="destructive" label={t("hasErrors")} /> : null
}

/**
 * Config | Notebase. Both panels stay mounted, so the form keeps one set of field instances and one
 * autosave session, and editor state such as undo history survives a tab switch.
 */
export function ActionEditorTabs({
  config,
  notebase,
}: {
  config: React.ReactNode
  notebase: React.ReactNode
}) {
  const [tab, setTab] = useAtom(customActionEditorTabAtom)
  const tabBarRef = useRef<HTMLDivElement>(null)

  const handleValueChange = (value: CustomActionEditorTab) => {
    setTab(value)
    // After a switch from far down a tall panel, bring the bar back so the new panel shows its top.
    requestAnimationFrame(() => {
      const bar = tabBarRef.current
      if (!bar) return
      const clearance = Number.parseFloat(getComputedStyle(bar).scrollMarginTop) || 0
      if (bar.getBoundingClientRect().top < clearance) {
        bar.scrollIntoView({ block: "start" })
      }
    })
  }

  return (
    <Tabs value={tab} onValueChange={handleValueChange} className="gap-4">
      <div ref={tabBarRef} className={cn("-mx-4 border-b px-3 pb-2", SCROLL_MARGIN)}>
        <TabsList
          variant="line"
          className="justify-start gap-4 [&_[data-slot=tabs-indicator]]:bottom-[-9px]"
        >
          <TabsTrigger value="config" className="flex-none px-1">
            {t("config")}
            <ConfigTabStatus />
          </TabsTrigger>
          <TabsTrigger
            id={CUSTOM_ACTION_NOTEBASE_SECTION_ID}
            value="notebase"
            className={cn("flex-none px-1", SCROLL_MARGIN)}
          >
            {i18n.t("anki.title")}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="config" keepMounted>
        {config}
      </TabsContent>
      <TabsContent value="notebase" keepMounted>
        {notebase}
      </TabsContent>
    </Tabs>
  )
}

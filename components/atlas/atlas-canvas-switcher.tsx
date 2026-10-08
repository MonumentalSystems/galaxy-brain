import type { ChangeEvent } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { CanvasRecord } from "@/lib/types/canvas"

export type AtlasCanvasSwitcherProps = {
  canvases: readonly CanvasRecord[]
  activeCanvasId: string | null
  disabled?: boolean
  onSelect: (canvasId: string) => void
  createAction?: Readonly<{
    label: string
    disabled: boolean
    unavailableReason: string | null
    onInvoke: (trigger: HTMLButtonElement) => void
  }> | null
}

export function AtlasCanvasSwitcher({
  canvases,
  activeCanvasId,
  disabled = false,
  onSelect,
  createAction = null,
}: AtlasCanvasSwitcherProps) {
  const activeCanvas = canvases.find((canvas) => canvas.canvasId === activeCanvasId) ?? null
  function selectCanvas(event: ChangeEvent<HTMLSelectElement>) {
    const canvasId = event.currentTarget.value
    if (!canvasId || canvasId === activeCanvasId) return
    onSelect(canvasId)
  }

  const createButton = createAction ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 min-w-0 max-w-full shrink-0 whitespace-normal px-3"
      disabled={createAction.disabled}
      title={createAction.disabled ? createAction.unavailableReason ?? undefined : undefined}
      aria-describedby="atlas-canvas-status"
      onClick={(event) => createAction.onInvoke(event.currentTarget)}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      {createAction.label}
    </Button>
  ) : null

  if (canvases.length === 0) {
    return (
      <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <span className="research-smallcaps shrink-0 text-[10px]">Canvas</span>
        <span className="min-w-0 flex-1">
          <strong className="block break-words text-sm">Unsaved Atlas</strong>
          <span className="block text-xs text-[hsl(var(--research-muted))]">No durable canvases yet</span>
        </span>
        {createButton}
      </div>
    )
  }

  if (canvases.length === 1) {
    const canvas = canvases[0]
    return (
      <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <span className="research-smallcaps shrink-0 text-[10px]">Canvas</span>
        <strong className="min-w-0 flex-1 break-words text-sm">
          {canvas.title} — Current{canvas.isDefault ? " — Default" : ""}
        </strong>
        {createButton}
      </div>
    )
  }

  return (
    <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <label className="research-smallcaps shrink-0 text-[10px]" htmlFor="atlas-canvas-switcher">
        Canvas
      </label>
      <select
        id="atlas-canvas-switcher"
        className="min-h-11 min-w-0 max-w-full flex-1 rounded-lg border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] px-3 py-2 text-sm font-semibold text-[hsl(var(--research-ink))] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        value={activeCanvas?.canvasId ?? ""}
        disabled={disabled || !activeCanvas}
        aria-describedby="atlas-canvas-status"
        onChange={selectCanvas}
      >
        {!activeCanvas ? <option value="">Current canvas unavailable</option> : null}
        {canvases.map((canvas) => (
          <option key={canvas.canvasId} value={canvas.canvasId}>
            {canvas.title}{canvas.canvasId === activeCanvasId ? " — Current" : ""}{canvas.isDefault ? " — Default" : ""}
          </option>
        ))}
      </select>
      {createButton}
    </div>
  )
}

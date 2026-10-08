import { worldToScreen } from "@canvas-harness/core"

const DEFAULT_MARGIN = 12
const DEFAULT_GAP = 12

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function dimension(value) {
  return Math.max(0, finite(value))
}

function clamp(value, minimum, maximum) {
  if (maximum <= minimum) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Project one selected Atlas node into a viewport-safe HUD position.
 *
 * This is presentation geometry only. It deliberately receives no object
 * reference or command data, so docking a HUD cannot acquire or retain object
 * authority. The caller must unmount it when there is no current atomic node.
 */
export function positionAtlasSelectionHud({
  nodeBounds,
  camera,
  viewport,
  hud,
  pinnedPosition = null,
  insets = {},
  margin = DEFAULT_MARGIN,
  gap = DEFAULT_GAP,
}) {
  const safeMargin = Math.max(0, finite(margin, DEFAULT_MARGIN))
  const safeGap = Math.max(0, finite(gap, DEFAULT_GAP))
  const viewportWidth = dimension(viewport?.width)
  const viewportHeight = dimension(viewport?.height)
  const hudWidth = dimension(hud?.width)
  const hudHeight = dimension(hud?.height)
  if (viewportWidth === 0 || viewportHeight === 0 || hudWidth === 0 || hudHeight === 0) return null
  const minX = safeMargin + dimension(insets.left)
  const minY = safeMargin + dimension(insets.top)
  const maxX = Math.max(minX, viewportWidth - hudWidth - safeMargin - dimension(insets.right))
  const maxY = Math.max(minY, viewportHeight - hudHeight - safeMargin - dimension(insets.bottom))

  if (pinnedPosition) {
    return Object.freeze({
      left: clamp(finite(pinnedPosition.left, minX), minX, maxX),
      top: clamp(finite(pinnedPosition.top, minY), minY, maxY),
      placement: "pinned",
    })
  }

  const centerX = finite(nodeBounds?.x) + dimension(nodeBounds?.w) / 2
  const topY = finite(nodeBounds?.y)
  const bottomY = topY + dimension(nodeBounds?.h)
  const below = worldToScreen({ x: centerX, y: bottomY }, camera)
  const above = worldToScreen({ x: centerX, y: topY }, camera)
  const fitsAbove = above.y - safeGap - hudHeight >= minY
  const desiredY = fitsAbove
    ? above.y - safeGap - hudHeight
    : below.y + safeGap

  return Object.freeze({
    left: clamp(below.x - hudWidth / 2, minX, maxX),
    top: clamp(desiredY, minY, maxY),
    placement: fitsAbove ? "above" : "below",
  })
}

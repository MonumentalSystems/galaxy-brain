import { panByScreen } from "@canvas-harness/core"

import { zoomForLevel } from "../object-projector-registry.js"

/*
  Both zooms are derived from the semantic levels rather than written out, so
  the camera cannot open at a zoom the projectors treat as a different level.
  It used to: 0.82 against a 1.3 card threshold meant the atlas opened with
  every placement drawn as a label, title showing and body empty.

  An atlas opens close enough to read its objects; a large one pulls back to
  where their labels still resolve, rather than to bare glyphs.
*/
export const ATLAS_MEDIUM_ZOOM = zoomForLevel("near")
export const ATLAS_CAMERA_PAN_STEP = 96

export const ATLAS_FAR_OVERVIEW_ZOOM = zoomForLevel("medium")
const CAMERA_MARGIN = 64
const CAMERA_PAN_DELTAS = Object.freeze({
  up: Object.freeze({ x: 0, y: ATLAS_CAMERA_PAN_STEP }),
  down: Object.freeze({ x: 0, y: -ATLAS_CAMERA_PAN_STEP }),
  left: Object.freeze({ x: ATLAS_CAMERA_PAN_STEP, y: 0 }),
  right: Object.freeze({ x: -ATLAS_CAMERA_PAN_STEP, y: 0 }),
})

export function panAtlasCamera(camera, direction) {
  const delta = CAMERA_PAN_DELTAS[direction]
  if (!delta) throw new TypeError("Atlas camera pan direction is invalid")
  return panByScreen(camera, delta)
}

/**
 * Choose a deterministic opening camera without depending on viewport size.
 * A requested placement wins over the overview so deep links always reveal
 * their target, while small unselected atlases open at a readable semantic
 * zoom rather than the glyph-only level.
 */
export function cameraForAtlasNodes(nodes, selectedNodeId) {
  const values = Array.isArray(nodes) ? nodes : []
  const selected = selectedNodeId
    ? values.find((node) => node?.id === selectedNodeId)
    : null
  if (selected && Number.isFinite(selected.x) && Number.isFinite(selected.y)) {
    return {
      x: selected.x - CAMERA_MARGIN,
      y: selected.y - CAMERA_MARGIN,
      z: ATLAS_MEDIUM_ZOOM,
    }
  }
  return {
    x: -60,
    y: -40,
    z: values.length > 40 ? ATLAS_FAR_OVERVIEW_ZOOM : ATLAS_MEDIUM_ZOOM,
  }
}

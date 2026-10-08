import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { positionAtlasSelectionHud } from "../lib/canvas/atlas-selection-hud.js"

const nodeBounds = { x: 100, y: 100, w: 200, h: 120 }
const camera = { x: 0, y: 0, z: 1 }
const viewport = { width: 800, height: 600 }
const hud = { width: 300, height: 72 }
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("selection HUD follows the selected world bounds and prefers the space above", () => {
  assert.deepEqual(positionAtlasSelectionHud({ nodeBounds, camera, viewport, hud }), {
    left: 50,
    top: 16,
    placement: "above",
  })

  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds,
    camera: { x: 50, y: 25, z: 2 },
    viewport,
    hud,
  }), {
    left: 150,
    top: 66,
    placement: "above",
  })
})

test("reserved chrome insets keep the HUD clear of mobile and desktop controls", () => {
  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds: { x: 120, y: 700, w: 120, h: 80 },
    camera,
    viewport: { width: 390, height: 844 },
    hud: { width: 340, height: 72 },
    insets: { top: 132, bottom: 156 },
  }), { left: 12, top: 604, placement: "above" })

  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds: { x: 120, y: 500, w: 120, h: 80 },
    camera,
    viewport: { width: 320, height: 568 },
    hud: { width: 296, height: 72 },
    insets: { top: 132, bottom: 156 },
  }), { left: 12, top: 328, placement: "above" })

  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds: { x: 100, y: 8, w: 100, h: 40 },
    camera,
    viewport: { width: 390, height: 844 },
    hud: { width: 340, height: 72 },
    insets: { top: 190, bottom: 156 },
  }), { left: 12, top: 202, placement: "below" })
})

test("selection HUD flips below near the top and clamps every viewport edge", () => {
  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds: { x: -500, y: 4, w: 40, h: 40 },
    camera,
    viewport: { width: 320, height: 180 },
    hud: { width: 500, height: 80 },
  }), {
    left: 12,
    top: 56,
    placement: "below",
  })

  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds: { x: 2_000, y: 2_000, w: 20, h: 20 },
    camera,
    viewport,
    hud,
  }), {
    left: 488,
    top: 516,
    placement: "above",
  })
})

test("a pinned HUD ignores world motion but reclamps after viewport shrink", () => {
  const pinnedPosition = { left: 420, top: 360 }
  const first = positionAtlasSelectionHud({ nodeBounds, camera, viewport, hud, pinnedPosition })
  const moved = positionAtlasSelectionHud({
    nodeBounds: { x: -9_000, y: 4_000, w: 1, h: 1 },
    camera: { x: 800, y: -500, z: 4 },
    viewport,
    hud,
    pinnedPosition,
  })
  assert.deepEqual(first, { left: 420, top: 360, placement: "pinned" })
  assert.deepEqual(moved, first)
  assert.deepEqual(positionAtlasSelectionHud({
    nodeBounds,
    camera,
    viewport: { width: 390, height: 240 },
    hud,
    pinnedPosition,
  }), { left: 78, top: 156, placement: "pinned" })
})

test("selection HUD waits for measurable viewport and toolbar dimensions", () => {
  assert.equal(positionAtlasSelectionHud({
    nodeBounds,
    camera,
    viewport: { width: 0, height: 600 },
    hud,
  }), null)
  assert.equal(positionAtlasSelectionHud({
    nodeBounds,
    camera,
    viewport,
    hud: { width: 300, height: 0 },
  }), null)
})

test("Atlas mounts the native contextual toolbar only at atomic LOD and reuses authorized actions", async () => {
  const [client, toolbar, removeDialog, styles] = await Promise.all([
    read("app/atlas-v2/atlas-v2-client.tsx"),
    read("components/ui/hud-toolbar.tsx"),
    read("components/atlas/placement-remove-dialog.tsx"),
    read("app/globals.css"),
  ])

  assert.match(client, /lodLevel === "atomic" \? \(\s*<AtlasSelectionHud/)
  assert.match(client, /function AtlasSelectedNodeHud[\s\S]*useNode\(nodeId\)/)
  assert.match(client, /openActionForAtlasNode\(nodeData, hydration\)/)
  assert.match(client, /atlasContextLensLinks\(nodeData\.subjectRef, hydration\)/)
  assert.match(client, /resolveAtlasTaskSelection\(/)
  assert.match(client, /"task\.plan\.open"/)
  assert.match(client, /"placement\.remove"/)
  assert.match(client, /function AccessibleAtlasList[\s\S]*Remove from Atlas/)
  assert.match(client, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(client, /const moving = useIsMoving\(\)/)
  assert.match(client, /const visiblePosition = moving && !pinned \? null : position/)
  assert.match(client, /obstacleRect\.bottom - viewportRect\.top/)
  assert.match(client, /observer\.observe\(topObstacleRef\.current\)/)
  assert.match(client, /hud\?\.contains\(document\.activeElement\)[\s\S]*querySelector<HTMLElement>\("\[data-canvas-host\]"\)[\s\S]*focus\(\{ preventScroll: true \}\)/)
  assert.match(client, /aria-pressed=\{pinned\}/)
  assert.match(toolbar, /export const HudLink[\s\S]*<a/)
  assert.match(removeDialog, /returnFocus\?\.isConnected \? returnFocus : fallbackFocus\?\.\(\)/)
  assert.match(styles, /\.atlas-selection-hud[\s\S]*pointer-events: none/)
  assert.match(styles, /\.atlas-selection-hud > \.hud-toolbar[\s\S]*pointer-events: auto/)
})

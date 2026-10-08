import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  ATLAS_CONSTELLATION_FAR_MAX,
  ATLAS_CONSTELLATION_MEDIUM_MAX,
  ATLAS_CONSTELLATION_NODE_TYPE,
  deriveAtlasConstellationScene,
  initialAtlasConstellationLevel,
  nextAtlasConstellationLevel,
  paintAtlasConstellationNode,
} from "../lib/canvas/atlas-constellation-lod.js"

function sourceNode(index, options = {}) {
  return {
    id: `private-source-${index}`,
    type: "galaxy.note",
    x: (index % 100) * 137,
    y: Math.floor(index / 100) * 91,
    w: 120,
    h: 80,
    data: {
      availability: options.unavailable ? "unavailable" : "resolved",
      subjectRef: `gb:artifact:private-${index}`,
      display: { title: `Secret title ${index}` },
    },
  }
}

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/giu).map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test("far and medium grid scenes stay within their declared aggregate caps", () => {
  const source = Array.from({ length: 10_000 }, (_, index) => sourceNode(index))
  const far = deriveAtlasConstellationScene(source, "far")
  const medium = deriveAtlasConstellationScene(source, "medium")

  assert.equal(far.sourceCount, source.length)
  assert.equal(medium.sourceCount, source.length)
  assert.ok(far.nodes.length <= ATLAS_CONSTELLATION_FAR_MAX)
  assert.ok(medium.nodes.length <= ATLAS_CONSTELLATION_MEDIUM_MAX)
  assert.ok(medium.nodes.length >= far.nodes.length)
  assert.deepEqual(far.edges, [])
  assert.deepEqual(medium.edges, [])
  assert.equal(far.nodes.reduce((sum, node) => sum + node.data.counts.total, 0), source.length)
  assert.equal(medium.nodes.reduce((sum, node) => sum + node.data.counts.total, 0), source.length)
})

test("binning is deterministic regardless of source ordering", () => {
  const source = Array.from({ length: 417 }, (_, index) => sourceNode(index, {
    unavailable: index % 7 === 0,
  }))
  const forward = deriveAtlasConstellationScene(source, "medium")
  const reverse = deriveAtlasConstellationScene([...source].reverse(), "medium")
  assert.deepEqual(reverse, forward)
  assert.ok(forward.nodes.every((node) => node.type === ATLAS_CONSTELLATION_NODE_TYPE))
  assert.ok(forward.nodes.every((node) => node.locked === true))
})

test("aggregates expose only geometry and counts, including unavailable counts", () => {
  const scene = deriveAtlasConstellationScene([
    sourceNode(1),
    sourceNode(2, { unavailable: true }),
    sourceNode(3, { unavailable: true }),
  ], "far")
  const serialized = JSON.stringify(scene)

  assert.equal(scene.nodes.reduce((sum, node) => sum + node.data.counts.resolved, 0), 1)
  assert.equal(scene.nodes.reduce((sum, node) => sum + node.data.counts.unavailable, 0), 2)
  assert.doesNotMatch(serialized, /Secret title|private-source|subjectRef|gb:artifact/u)
  for (const node of scene.nodes) {
    assert.deepEqual(Object.keys(node.data).sort(), ["cell", "counts", "level", "schemaId"])
  }
})

test("constellation paint keeps count text and strokes legible at far zoom", () => {
  const node = deriveAtlasConstellationScene([sourceNode(1)], "far").nodes[0]
  const observations = []
  const context = {
    beginPath() {},
    arc() {},
    fill() {},
    fillRect() {},
    stroke() { observations.push({ lineWidth: this.lineWidth }) },
    fillText(value) { observations.push({ font: this.font, value }) },
  }
  paintAtlasConstellationNode(context, node, { zoom: 0.08 })

  const stroke = observations.find((entry) => entry.lineWidth)
  const text = observations.find((entry) => entry.font)
  assert.ok(stroke.lineWidth > 10)
  assert.match(text.font, /^650 (?:[89]\d|1\d\d(?:\.\d+)?)px/u)
  assert.equal(text.value, "1")
})

test("readable overview markers name object counts and unavailable state", () => {
  const resolved = sourceNode(1)
  const unavailable = {
    ...sourceNode(2, { unavailable: true }),
    x: resolved.x,
    y: resolved.y,
  }
  const node = deriveAtlasConstellationScene([
    resolved,
    unavailable,
  ], "medium").nodes[0]
  const labels = []
  const context = {
    beginPath() {},
    arc() {},
    fill() {},
    fillRect() { labels.push(this.fillStyle) },
    stroke() {},
    fillText(value) { labels.push(value) },
  }
  paintAtlasConstellationNode(context, node, { zoom: 0.5 })

  assert.deepEqual(labels, ["#fffef9", "2", "placements", "1 unavailable"])
  for (const foreground of ["#1e2a24", "#456255", "#8f3f2a"]) {
    assert.ok(contrastRatio(foreground, "#fffef9") >= 4.5, `${foreground} must remain AA on the label plate`)
  }
})

test("empty scenes remain empty and do not synthesize topology", () => {
  assert.deepEqual(deriveAtlasConstellationScene([], "far"), {
    level: "far",
    sourceCount: 0,
    nodes: [],
    edges: [],
  })
})

test("semantic scale selection is deterministic and hysteretic", () => {
  assert.equal(initialAtlasConstellationLevel(0.1), "far")
  assert.equal(initialAtlasConstellationLevel(0.35), "medium")
  assert.equal(initialAtlasConstellationLevel(0.8), "atomic")

  assert.equal(nextAtlasConstellationLevel(0.18, "far"), "far")
  assert.equal(nextAtlasConstellationLevel(0.21, "far"), "medium")
  assert.equal(nextAtlasConstellationLevel(0.82, "far"), "atomic")
  assert.equal(nextAtlasConstellationLevel(0.18, "medium"), "medium")
  assert.equal(nextAtlasConstellationLevel(0.13, "medium"), "far")
  assert.equal(nextAtlasConstellationLevel(0.5, "medium"), "medium")
  assert.equal(nextAtlasConstellationLevel(0.59, "medium"), "atomic")
  assert.equal(nextAtlasConstellationLevel(0.4, "atomic"), "medium")
  assert.throws(() => nextAtlasConstellationLevel(0.5, "regional"), /current level/u)
})

test("invalid levels and geometry fail closed", () => {
  assert.throws(() => deriveAtlasConstellationScene({}, "far"), /nodes must be an array/u)
  assert.throws(() => deriveAtlasConstellationScene([], "near"), /level must be far or medium/u)
  assert.throws(() => deriveAtlasConstellationScene([{ x: 0, y: 0, w: 0, h: 20 }], "far"), /dimensions must be positive/u)
  assert.throws(() => deriveAtlasConstellationScene([{ x: Number.NaN, y: 0, w: 20, h: 20 }], "far"), /must be finite/u)
})

test("constellation node registration is canvas-only with no React view", async () => {
  const source = await readFile(new URL("../lib/canvas/atlas-constellation-node-types.ts", import.meta.url), "utf8")
  assert.match(source, /renderCanvas:\s*paintAtlasConstellationNode/u)
  assert.match(source, /drawPlaceholder:\s*paintAtlasConstellationNode/u)
  assert.doesNotMatch(source, /\bview\s*:/u)
})

test("Atlas keeps durable placement authority outside the derived scene", async () => {
  const source = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(source, /store:\s*asPlacementCanvasStore\(store\)/u)
  assert.match(source, /store:\s*asReadOnlyCanvasStore\(sourceStore\)/u)
  assert.match(source, /runtime\.store\.subscribe\("change"/u)
  assert.doesNotMatch(source, /runtime\.constellations\.[a-z]+\.store\.subscribe\("change"/u)
  assert.match(source, /<CanvasProvider store=\{runtime\.store\}>[\s\S]*<CanvasProvider store=\{activeStore\}>/u)
  assert.match(source, /lodLevelRef\.current !== "atomic"/u)
  assert.match(source, /applyCanvasPlacementOverrides\(projection/u)
})

test("overview action crosses the atomic threshold instead of resetting a large Atlas", async () => {
  const source = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(
    source,
    /const zoomToExactObjects = useCallback[\s\S]*ATLAS_CONSTELLATION_ZOOM\.leaveMedium \+ 0\.08/u,
  )
  assert.match(source, /onZoomToObjects=\{zoomToExactObjects\}/u)
  assert.match(source, /ref=\{atlasScaleStatusRef\}[\s\S]*tabIndex=\{-1\}[\s\S]*focus-visible:ring-2/u)
  assert.match(source, /atlasScaleStatusRef\.current\?\.focus\(\{ preventScroll: true \}\)/u)
  assert.match(source, /aria-current=\{label === scaleLabel \? "step" : undefined\}/u)
  assert.match(source, /ref=\{headingRef\}[\s\S]*Exact Atlas placements/u)
  assert.match(source, /atlasListHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\)/u)
})

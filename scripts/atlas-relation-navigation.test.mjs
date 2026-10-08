import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  resolveAtlasProjectedRelationEndpoint,
  resolveAtlasRuntimeRelationEndpoint,
} from "../lib/canvas/atlas-relation-navigation.js"

const sourceNode = {
  id: "opaque-node-a",
  data: {
    schemaId: "gb.canvas.node.v1",
    placementId: "placement:with:delimiters",
    availability: "resolved",
    display: { title: "Source theorem" },
  },
}
const targetNode = {
  id: "opaque-node-b",
  data: {
    schemaId: "gb.canvas.node.v1",
    placementId: "relation:campaign",
    availability: "resolved",
    display: { title: "Target evidence" },
  },
}
const relationEdge = {
  id: "do-not-parse:this:id",
  source: { nodeId: sourceNode.id },
  target: { nodeId: targetNode.id },
  data: { schemaId: "gb.canvas.relation.v1", trustClass: "asserted" },
}

test("runtime relation endpoints resolve only through current edge anchors", () => {
  const nodes = new Map([[sourceNode.id, sourceNode], [targetNode.id, targetNode]])
  assert.deepEqual(
    resolveAtlasRuntimeRelationEndpoint(relationEdge, "source", (id) => nodes.get(id)),
    { nodeId: sourceNode.id, placementId: sourceNode.data.placementId, label: "Source theorem" },
  )
  assert.deepEqual(
    resolveAtlasRuntimeRelationEndpoint(relationEdge, "target", (id) => nodes.get(id)),
    { nodeId: targetNode.id, placementId: targetNode.data.placementId, label: "Target evidence" },
  )
})

test("runtime relation navigation fails closed for stale or identity-mismatched nodes", () => {
  assert.equal(resolveAtlasRuntimeRelationEndpoint(relationEdge, "source", () => undefined), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint(relationEdge, "source", () => targetNode), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint({ ...relationEdge, data: {} }, "source", () => sourceNode), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint(relationEdge, "middle", () => sourceNode), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint({
    ...relationEdge,
    target: relationEdge.source,
  }, "source", () => sourceNode), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint(relationEdge, "source", () => ({
    ...sourceNode,
    data: { ...sourceNode.data, availability: "unavailable" },
  })), null)
  assert.equal(resolveAtlasRuntimeRelationEndpoint({
    ...relationEdge,
    source: { nodeId: "" },
  }, "source", () => sourceNode), null)
})

test("projected relation endpoints resolve explicit placement identities without parsing relation IDs", () => {
  const placements = [
    { id: sourceNode.data.placementId, authorized: true, availability: "resolved", display: { title: "Source theorem" } },
    { id: targetNode.data.placementId, authorized: true, availability: "resolved", display: { title: "Target evidence" } },
  ]
  const byId = new Map(placements.map((placement) => [placement.id, placement]))
  const relation = {
    id: "opaque:relation:identifier",
    sourcePlacementId: sourceNode.data.placementId,
    targetPlacementId: targetNode.data.placementId,
  }
  assert.deepEqual(
    resolveAtlasProjectedRelationEndpoint(relation, "source", (id) => [byId.get(id)].filter(Boolean)),
    { placementId: sourceNode.data.placementId, label: "Source theorem" },
  )
  assert.deepEqual(
    resolveAtlasProjectedRelationEndpoint(relation, "target", (id) => [byId.get(id)].filter(Boolean)),
    { placementId: targetNode.data.placementId, label: "Target evidence" },
  )
  assert.equal(resolveAtlasProjectedRelationEndpoint(relation, "source", () => undefined), null)
  assert.equal(resolveAtlasProjectedRelationEndpoint(relation, "source", () => [placements[1]]), null)
  assert.equal(resolveAtlasProjectedRelationEndpoint(relation, "source", () => [placements[0], placements[0]]), null)
  assert.equal(resolveAtlasProjectedRelationEndpoint(relation, "target", () => [placements[1], placements[1]]), null)
  assert.equal(resolveAtlasProjectedRelationEndpoint({
    ...relation,
    targetPlacementId: relation.sourcePlacementId,
  }, "source", () => [placements[0]]), null)
  assert.equal(resolveAtlasProjectedRelationEndpoint(relation, "source", () => [{
    ...placements[0],
    authorized: false,
    availability: "unavailable",
  }]), null)
})

test("Atlas relation navigation reuses selection and placement-focus seams without new authority", async () => {
  const source = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(source, /resolveAtlasRuntimeRelationEndpoint/)
  assert.match(source, /resolveAtlasProjectedRelationEndpoint/)
  assert.match(source, /Focus source/)
  assert.match(source, /Focus target/)
  assert.match(source, /store\.setSelection\(\[endpoint\.nodeId\]\)/)
  assert.match(source, /cameraForAtlasNodes\(store\.getAllNodes\(\), endpoint\.nodeId\)/)
  assert.match(source, /setRelationFocusPlacementId\(placementId\)/)
  assert.match(source, /consumeMissingRelationFocus[\s\S]{0,180}onFocusPlacementConsumed\(focusPlacementId\)/)
  assert.match(source, /aria-label=\{endpoint \? `Focus \$\{side\}: \$\{endpoint\.label\}`/)
  assert.match(source, /querySelector<HTMLElement>\("\[data-canvas-host\]"\)[\s\S]{0,120}focus\(\{ preventScroll: true \}\)/)
  assert.ok((source.match(/h-auto min-h-11[^\"]*max-w-full whitespace-normal break-words/g) ?? []).length >= 3)
  assert.match(source, /<strong className="break-words">/)
  assert.doesNotMatch(source, /edge\.id\.(?:split|match|replace|slice)/)
})

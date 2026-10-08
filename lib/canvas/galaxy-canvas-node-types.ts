"use client"

import { defineNode, type NodeTypeDef } from "@canvas-harness/core"

import { GalaxyCanvasNodeView } from "@/components/canvas/galaxy-canvas-node"
import {
  GALAXY_CANVAS_NODE_TYPES,
  type GalaxyCanvasNodeType,
} from "@/lib/canvas/galaxy-canvas-adapter"
import { paintGalaxyCanvasNode } from "@/lib/canvas/galaxy-canvas-painter"

const GALAXY_NODE_LOD = {
  minZoomForReact: 0.7,
  minZoomForPlaceholder: 0.2,
} as const

function defineGalaxyNode(type: GalaxyCanvasNodeType): NodeTypeDef {
  return defineNode({
    type,
    view: GalaxyCanvasNodeView,
    // v0.2.0 uses renderCanvas for a custom node while it is dragged and
    // drawPlaceholder for distant/strip rendering. Keep both paths cheap.
    renderCanvas: paintGalaxyCanvasNode,
    drawPlaceholder: paintGalaxyCanvasNode,
    lod: GALAXY_NODE_LOD,
  })
}

/** Static, code-owned custom-node registry. Surface data cannot extend it. */
export const GALAXY_CANVAS_NODE_DEFINITIONS = Object.freeze(
  GALAXY_CANVAS_NODE_TYPES.map(defineGalaxyNode),
)

/** Runtime-friendly alias used when constructing the client-owned store. */
export const galaxyCanvasNodeTypes = GALAXY_CANVAS_NODE_DEFINITIONS

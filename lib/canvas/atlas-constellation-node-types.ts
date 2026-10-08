"use client"

import { defineNode, type NodeTypeDef } from "@canvas-harness/core"

import {
  ATLAS_CONSTELLATION_NODE_TYPE,
  paintAtlasConstellationNode,
} from "@/lib/canvas/atlas-constellation-lod"

/** Canvas-only: aggregate overview nodes never mount a React component. */
export const ATLAS_CONSTELLATION_NODE_DEFINITION: NodeTypeDef = defineNode({
  type: ATLAS_CONSTELLATION_NODE_TYPE,
  renderCanvas: paintAtlasConstellationNode,
  drawPlaceholder: paintAtlasConstellationNode,
  lod: {
    minZoomForReact: Number.POSITIVE_INFINITY,
    minZoomForPlaceholder: 0,
  },
})

export const atlasConstellationNodeTypes = Object.freeze([
  ATLAS_CONSTELLATION_NODE_DEFINITION,
])

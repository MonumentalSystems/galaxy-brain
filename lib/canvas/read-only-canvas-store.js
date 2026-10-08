import { asNodeId } from "@canvas-harness/core"

export const BLOCKED_CANVAS_STORE_METHODS = Object.freeze([
  "addNode",
  "updateNode",
  "removeNode",
  "addImage",
  "addSvg",
  "addEdge",
  "updateEdge",
  "removeEdge",
  "upsertGroup",
  "removeGroup",
  "bringToFront",
  "sendToBack",
  "bringForward",
  "sendBackward",
  "applyOp",
  "applyBatch",
  "undo",
  "redo",
  "setFrameOrder",
  "beginEdit",
  "commitEdit",
])

const BLOCKED_METHOD_SET = new Set(BLOCKED_CANVAS_STORE_METHODS)

/**
 * Permit local camera, selection, presence, and interaction state while
 * refusing scene mutations. This is a preview UX boundary, not an
 * authorization mechanism; the server remains the authority for durable data.
 */
export function asReadOnlyCanvasStore(store) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (!BLOCKED_METHOD_SET.has(property)) return Reflect.get(target, property, receiver)
      if (property === "addNode") return (node) => node.id
      if (property === "addEdge") return (edge) => edge.id
      if (property === "addImage" || property === "addSvg") {
        return async () => asNodeId("readonly:blocked")
      }
      if (property === "undo" || property === "redo") return () => false
      return () => undefined
    },
  })
}

const PLACEMENT_FIELDS = new Set(["x", "y", "w", "h", "z"])

/**
 * Permit local placement gestures while refusing content, topology, history,
 * and raw renderer-operation mutations. The server still authorizes and
 * versions every durable placement command.
 */
export function asPlacementCanvasStore(store) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "updateNode") {
        return (id, patch) => {
          const placementPatch = Object.fromEntries(
            Object.entries(patch).filter(([key, value]) => PLACEMENT_FIELDS.has(key) && Number.isFinite(value)),
          )
          if (Object.keys(placementPatch).length > 0) target.updateNode(id, placementPatch)
        }
      }
      if (!BLOCKED_METHOD_SET.has(property)) return Reflect.get(target, property, receiver)
      if (property === "addNode") return (node) => node.id
      if (property === "addEdge") return (edge) => edge.id
      if (property === "addImage" || property === "addSvg") {
        return async () => asNodeId("placement:blocked")
      }
      if (property === "undo" || property === "redo") return () => false
      return () => undefined
    },
  })
}

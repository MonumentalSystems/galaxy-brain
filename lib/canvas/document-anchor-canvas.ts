import { setBrowserTenantScope } from "@/lib/browser-utils"
import { createDocumentAnchorCanvasItem } from "@/lib/canvas/document-anchor-placement.js"
import {
  advanceDocumentAnchorPlacementRecovery,
  readDocumentAnchorPlacementRecovery,
  runRecoverableDocumentAnchorPlacement,
} from "@/lib/canvas/document-anchor-placement-recovery.js"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { galaxyBrainService } from "@/lib/galaxy-brain-service"
import type { DurableDocumentAnchor } from "@/lib/paper-reader-client"
import type { CanvasEnvelope } from "@/lib/types/canvas"

export type PlaceDocumentAnchorResult = {
  canvas: CanvasEnvelope
  canvasId: string
  placementId: string
  replayed: boolean
}

export type DocumentAnchorPlacementStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

class MissingDocumentAnchorPlacementError extends Error {
  constructor(
    readonly canvasId: string,
    readonly operationId: string,
  ) {
    super("The recovered Atlas placement is no longer present.")
  }
}

function recoveryScope(anchor: DurableDocumentAnchor, tenantId: string, principalId: string) {
  return {
    tenantId,
    principalId,
    documentRevisionId: anchor.document_revision_id,
    anchorId: anchor.id,
  }
}

function isExactAnchorPlacement(
  canvas: CanvasEnvelope,
  placementId: string,
  anchor: DurableDocumentAnchor,
) {
  const item = canvas.content.items.find((candidate) => candidate.id === placementId)
  return Boolean(
    item
    && item.subjectRef === anchor.ref
    && item.nodeType === "galaxy.document"
    && item.style.schemaId === "gb.canvas.document-anchor-placement.v1"
    && item.style.documentRevisionId === anchor.document_revision_id.toLowerCase()
    && item.style.anchorId === anchor.id,
  )
}

function nextPlacementGeometry(canvas: CanvasEnvelope) {
  const index = canvas.content.items.length
  const highestZ = canvas.content.items.reduce((value, item) => Math.max(value, item.zIndex), -1)
  return {
    x: 80 + (index % 4) * 450,
    y: 80 + Math.floor(index / 4) * 300,
    zIndex: highestZ + 1,
  }
}

async function defaultCanvas(tenantId: string): Promise<CanvasEnvelope> {
  setBrowserTenantScope(tenantId)
  galaxyBrainService.setTenantScope(tenantId)
  const workspace = galaxyBrainService.getWorkspaces()[0]
  if (!workspace) throw new Error("Create a Galaxy workspace before placing this coordinate on the atlas.")

  const canvases = await galaxyBrainAPI.getCanvases(workspace.id)
  const defaults = canvases.filter((canvas) => canvas.isDefault)
  if (defaults.length > 1 || (canvases.length > 0 && defaults.length !== 1)) {
    throw new Error("This workspace does not have one unambiguous default canvas.")
  }
  if (defaults[0]) return galaxyBrainAPI.getCanvas(defaults[0].canvasId)
  return galaxyBrainAPI.createCanvas({
    workspaceId: workspace.id,
    slug: "main",
    title: `${workspace.name} atlas`,
    makeDefault: true,
    idempotencyKey: `canvas-create:${workspace.id}`,
  })
}

async function placeDocumentAnchorOnCanvas(
  anchor: DurableDocumentAnchor,
  tenantId: string,
  canvasId: string,
  operationId: string,
  sourcePage?: number,
): Promise<PlaceDocumentAnchorResult> {
  setBrowserTenantScope(tenantId)
  galaxyBrainService.setTenantScope(tenantId)
  const current = await galaxyBrainAPI.getCanvas(canvasId)
  const item = createDocumentAnchorCanvasItem(anchor, operationId, nextPlacementGeometry(current), sourcePage)
  const existing = current.content.items.find((candidate) => candidate.id === item.id)
  if (existing) {
    if (existing.subjectRef !== item.subjectRef) {
      throw new Error("The recovered canvas placement id belongs to a different object.")
    }
    return { canvas: current, canvasId: current.canvasId, placementId: item.id, replayed: true }
  }
  if (current.content.removedItemIds.includes(item.id)) {
    throw new MissingDocumentAnchorPlacementError(current.canvasId, operationId)
  }
  const updated = await galaxyBrainAPI.mutateCanvas(current.canvasId, {
    expectedVersion: current.version,
    expectedContentHash: current.contentHash,
    idempotencyKey: `document-anchor-place:${operationId.toLowerCase()}`,
    commands: [{ type: "item.place", item }],
  })
  const authoritative = updated.replayed === true
    ? await galaxyBrainAPI.getCanvas(current.canvasId)
    : updated
  if (!isExactAnchorPlacement(authoritative, item.id, anchor)) {
    throw new MissingDocumentAnchorPlacementError(current.canvasId, operationId)
  }
  return {
    canvas: authoritative,
    canvasId: authoritative.canvasId,
    placementId: item.id,
    replayed: updated.replayed === true,
  }
}

/** Place one exact anchor as a new durable presentation of the canonical object. */
export async function placeDocumentAnchorOnDefaultCanvas(
  anchor: DurableDocumentAnchor,
  tenantId: string,
  operationId: string,
  sourcePage?: number,
): Promise<PlaceDocumentAnchorResult> {
  const current = await defaultCanvas(tenantId)
  return placeDocumentAnchorOnCanvas(anchor, tenantId, current.canvasId, operationId, sourcePage)
}

/**
 * Place an anchor with a reload-safe operation bound to one exact canvas.
 * Confirmed operations reconcile with the server; removed cards advance to a
 * new generation so historical idempotency cannot mask an intentional restore.
 */
export async function placeDocumentAnchorRecoverably(
  anchor: DurableDocumentAnchor,
  tenantId: string,
  principalId: string,
  storage: DocumentAnchorPlacementStorage,
  sourcePage?: number,
): Promise<PlaceDocumentAnchorResult> {
  const scope = recoveryScope(anchor, tenantId, principalId)
  const execute = () => runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    resolveCanvasId: async () => (await defaultCanvas(tenantId)).canvasId,
    place: (operationId, canvasId) => placeDocumentAnchorOnCanvas(
      anchor, tenantId, canvasId, operationId, sourcePage,
    ),
  })
  try {
    return (await execute()).result
  } catch (error) {
    if (!(error instanceof MissingDocumentAnchorPlacementError)) throw error
    await advanceDocumentAnchorPlacementRecovery(
      storage, scope, error.canvasId, error.operationId,
    )
    return (await execute()).result
  }
}

/** Return only an exact, currently authorized placement suitable for a deep link. */
export async function validateDocumentAnchorPlacementRecovery(
  anchor: DurableDocumentAnchor,
  tenantId: string,
  principalId: string,
  storage: DocumentAnchorPlacementStorage,
) {
  const scope = recoveryScope(anchor, tenantId, principalId)
  const recovery = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (recovery?.state !== "confirmed") return null
  setBrowserTenantScope(tenantId)
  galaxyBrainService.setTenantScope(tenantId)
  let canvas: CanvasEnvelope
  try {
    canvas = await galaxyBrainAPI.getCanvas(recovery.canvasId)
  } catch {
    return null
  }
  if (isExactAnchorPlacement(canvas, recovery.placementId, anchor)) return recovery
  await advanceDocumentAnchorPlacementRecovery(
    storage, scope, recovery.canvasId, recovery.operationId,
  )
  return null
}

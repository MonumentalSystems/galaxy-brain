import { contentProcessingService } from "./content-processing-service"
import { galaxyBrainAPI } from "./galaxy-brain-api"
import { type GalaxyNode, galaxyBrainService } from "./galaxy-brain-service"

export interface DatasourceImportedItem {
  id: string
  title: string
  path?: string | null
  mime_type?: string | null
  updated_at?: string | null
  size?: number | null
  content: string
  warnings?: string[]
}

export interface DatasourceRefreshPreview {
  node: GalaxyNode
  imported: DatasourceImportedItem
  hasConflict: boolean
  sourceChanged: boolean
  baselineFingerprint: string
  localFingerprint: string
  sourceFingerprint: string
}

export type DatasourceRefreshStrategy = "overwrite" | "duplicate"

export function getDatasourceContentFingerprint(title: string, content: string): string {
  const text = `${title}\n\n${content}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `ds-${(hash >>> 0).toString(16)}`
}

export function canRefreshDatasourceNode(node: GalaxyNode): boolean {
  return Boolean(
    typeof node.metadata?.datasourceId === "string" &&
    typeof node.metadata?.datasourceItemId === "string",
  )
}

export function hasDatasourceRefreshConflict(node: GalaxyNode): boolean {
  if (!canRefreshDatasourceNode(node)) return false
  const baseline = typeof node.metadata?.datasourceContentFingerprint === "string"
    ? node.metadata.datasourceContentFingerprint
    : ""
  if (!baseline) return false
  return baseline !== getDatasourceContentFingerprint(node.title, node.content)
}

function getRefreshEvents(node: GalaxyNode): Array<Record<string, unknown>> {
  return Array.isArray(node.metadata?.datasourceRefreshEvents)
    ? node.metadata.datasourceRefreshEvents as Array<Record<string, unknown>>
    : []
}

function appendRefreshEvent(node: GalaxyNode, event: Record<string, unknown>): Array<Record<string, unknown>> {
  return [event, ...getRefreshEvents(node)].slice(0, 12)
}

export async function fetchDatasourceRefreshPreview(node: GalaxyNode): Promise<DatasourceRefreshPreview> {
  const datasourceId = typeof node.metadata?.datasourceId === "string" ? node.metadata.datasourceId : ""
  const datasourceItemId = typeof node.metadata?.datasourceItemId === "string" ? node.metadata.datasourceItemId : ""

  if (!datasourceId || !datasourceItemId) {
    throw new Error("Node is not linked to a datasource item.")
  }

  const baselineFingerprint = typeof node.metadata?.datasourceContentFingerprint === "string"
    ? node.metadata.datasourceContentFingerprint
    : ""

  const result = await galaxyBrainAPI.importDatasourceItems(datasourceId, [datasourceItemId])
  const imported = result?.items?.[0]
  if (!imported) {
    throw new Error("Datasource refresh failed.")
  }

  const sourceFingerprint = getDatasourceContentFingerprint(imported.title || node.title, imported.content)
  const localFingerprint = getDatasourceContentFingerprint(node.title, node.content)

  return {
    node,
    imported,
    hasConflict: hasDatasourceRefreshConflict(node),
    sourceChanged: Boolean(baselineFingerprint) && baselineFingerprint !== sourceFingerprint,
    baselineFingerprint,
    localFingerprint,
    sourceFingerprint,
  }
}

export async function resolveDatasourceRefresh(
  preview: DatasourceRefreshPreview,
  strategy: DatasourceRefreshStrategy,
): Promise<GalaxyNode> {
  const { node, imported } = preview

  const nextTitle = imported.title || node.title
  const commonMetadata = {
    ...node.metadata,
    mimeType: imported.mime_type || node.metadata?.mimeType,
    datasourcePath: imported.path || node.metadata?.datasourcePath,
    datasourceImportedAt: node.metadata?.datasourceImportedAt || new Date().toISOString(),
    datasourceRefreshedAt: new Date().toISOString(),
    datasourceContentFingerprint: getDatasourceContentFingerprint(nextTitle, imported.content),
    datasourceWarnings: imported.warnings || [],
    datasourceRefreshEvents: appendRefreshEvent(node, {
      refreshedAt: new Date().toISOString(),
      strategy,
      sourcePath: imported.path || node.metadata?.datasourcePath || "",
      sourceUpdatedAt: imported.updated_at || null,
      hadConflict: preview.hasConflict,
    }),
  }

  if (strategy === "duplicate") {
    const duplicate = galaxyBrainService.createNode(
      node.type,
      `${nextTitle} (Source Copy)`,
      imported.content,
      node.category,
      node.parentId,
      { x: node.position.x + 32, y: node.position.y + 32 },
      { ...node.size },
    )
    const updatedDuplicate = galaxyBrainService.updateNode(duplicate.id, {
      tags: [...(node.tags || [])],
      metadata: commonMetadata,
    })
    const finalDuplicate = updatedDuplicate || duplicate
    contentProcessingService.enqueueNode(finalDuplicate.id)
    return finalDuplicate
  }

  const updated = galaxyBrainService.updateNode(node.id, {
    title: imported.title || node.title,
    content: imported.content,
    metadata: commonMetadata,
  })

  if (!updated) {
    throw new Error("Node update failed after datasource refresh.")
  }

  contentProcessingService.enqueueNode(updated.id)
  return updated
}

export async function refreshDatasourceNode(node: GalaxyNode, options?: { force?: boolean }): Promise<GalaxyNode> {
  const preview = await fetchDatasourceRefreshPreview(node)
  if (!options?.force && preview.hasConflict) {
    throw new Error("Local edits differ from the last imported source version. Confirm overwrite to refresh.")
  }
  return resolveDatasourceRefresh(preview, "overwrite")
}

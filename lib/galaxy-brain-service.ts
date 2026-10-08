import { galaxyBrainAPI, type NodeRevisionRecord } from "./galaxy-brain-api"
import { migrateDefaultTenantStorage, tenantStorageKey } from "./tenant-browser-storage"
import { weaviateService } from "./weaviate-service"
import type { CanvasComponentMetadata } from "./types/canvas-components"

export interface GalaxyNode {
  id: string
  type: string
  title: string
  content: string
  category: "ai" | "document" | "media" | "speech" | "knowledge"
  parentId: string | null
  position: { x: number; y: number }
  size: { width: number; height: number }
  tags?: string[]
  metadata?: Record<string, any>
  version?: number
  createdAt: Date
  updatedAt: Date
}

export interface GalaxyNodeSnapshot {
  type: string
  title: string
  content: string
  category: GalaxyNode["category"]
  parentId: string | null
  position: { x: number; y: number }
  size: { width: number; height: number }
  tags: string[]
  metadata: Record<string, any>
  version: number
  createdAt: string
  updatedAt: string
}

export interface GalaxyNodeRevision {
  id: string
  nodeId: string
  version: number
  timestamp: string
  source: string
  summary: string
  changedFields: string[]
  snapshot: GalaxyNodeSnapshot
}

export interface GalaxyNodeRevisionDiff {
  changedFields: string[]
  summaryLines: string[]
  beforePreview?: string
  afterPreview?: string
}

export interface NotebookRevisionBlockDiff {
  index: number
  status: "added" | "removed" | "changed" | "unchanged" | "type-changed"
  previousType?: string
  currentType?: string
  previousPreview?: string
  currentPreview?: string
}

export interface GalaxyWorkspace {
  id: string
  name: string
  description?: string
  rootFolderId: string
  createdAt: Date
  updatedAt: Date
}

export interface GalaxyFlow {
  id: string
  name: string
  description?: string
  workspaceId: string
  nodes: any[]
  edges: any[]
  createdAt: Date
  updatedAt: Date
}

export interface UserPreferences {
  viewMode?: string
  theme?: string
  sidebarOpen?: boolean
}

export interface UpdateNodeOptions {
  changeSource?: string
  skipHistory?: boolean
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _revisionSyncTimer: ReturnType<typeof setTimeout> | null = null
const HISTORY_LIMIT = 100

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseNotebookCellArray(content: string): Array<{ type?: string; id?: string }> | null {
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.every((cell) => cell && typeof cell === "object" && "type" in cell)) {
      return parsed as Array<{ type?: string; id?: string }>
    }
  } catch {}
  return null
}

function normalizeRevisionSnapshot(snapshot: Partial<GalaxyNodeSnapshot> | undefined): GalaxyNodeSnapshot {
  return {
    type: snapshot?.type || "note",
    title: snapshot?.title || "Untitled Note",
    content: snapshot?.content || "",
    category: (snapshot?.category as GalaxyNode["category"]) || "knowledge",
    parentId: snapshot?.parentId ?? null,
    position: {
      x: snapshot?.position?.x || 0,
      y: snapshot?.position?.y || 0,
    },
    size: {
      width: snapshot?.size?.width || 300,
      height: snapshot?.size?.height || 200,
    },
    tags: Array.isArray(snapshot?.tags) ? snapshot.tags : [],
    metadata: snapshot?.metadata || {},
    version: typeof snapshot?.version === "number" && snapshot.version > 0 ? snapshot.version : 1,
    createdAt: typeof snapshot?.createdAt === "string" ? snapshot.createdAt : new Date().toISOString(),
    updatedAt: typeof snapshot?.updatedAt === "string" ? snapshot.updatedAt : new Date().toISOString(),
  }
}

function extractNotebookBlockPreview(block: any): string {
  const value = block?.content ?? block?.text ?? block?.source ?? block?.value ?? ""
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function createTextPreview(content: string): string | undefined {
  const text = content.replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return text.length > 280 ? `${text.slice(0, 277)}...` : text
}

function formatNotebookDiff(beforeContent: string, afterContent: string): GalaxyNodeRevisionDiff {
  const beforeBlocks = JSON.parse(beforeContent) as any[]
  const afterBlocks = JSON.parse(afterContent) as any[]
  const maxBlocks = Math.max(beforeBlocks.length, afterBlocks.length)
  const summaryLines: string[] = []

  for (let index = 0; index < maxBlocks; index += 1) {
    const before = beforeBlocks[index]
    const after = afterBlocks[index]
    if (!before && after) {
      summaryLines.push(`Block ${index + 1} added (${after.type || "unknown"})`)
      continue
    }
    if (before && !after) {
      summaryLines.push(`Block ${index + 1} removed (${before.type || "unknown"})`)
      continue
    }
    if (!before || !after) continue
    if ((before.type || "unknown") !== (after.type || "unknown")) {
      summaryLines.push(`Block ${index + 1} type changed: ${before.type || "unknown"} -> ${after.type || "unknown"}`)
      continue
    }
    const beforePreview = extractNotebookBlockPreview(before)
    const afterPreview = extractNotebookBlockPreview(after)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      summaryLines.push(
        beforePreview !== afterPreview && afterPreview
          ? `Block ${index + 1} updated (${after.type || "unknown"}): ${afterPreview}`
          : `Block ${index + 1} updated (${after.type || "unknown"})`,
      )
    }
  }

  if (summaryLines.length === 0) {
    summaryLines.push("Notebook content matches this revision.")
  }

  return {
    changedFields: ["content"],
    summaryLines,
    beforePreview: createTextPreview(beforeBlocks.map(extractNotebookBlockPreview).filter(Boolean).join("\n")),
    afterPreview: createTextPreview(afterBlocks.map(extractNotebookBlockPreview).filter(Boolean).join("\n")),
  }
}

export function getNotebookRevisionBlockDiffs(currentContent: string, previousContent: string): NotebookRevisionBlockDiff[] {
  const currentCells = parseNotebookCellArray(currentContent)
  const previousCells = parseNotebookCellArray(previousContent)
  if (!currentCells || !previousCells) return []

  const maxBlocks = Math.max(currentCells.length, previousCells.length)
  const diffs: NotebookRevisionBlockDiff[] = []

  for (let index = 0; index < maxBlocks; index += 1) {
    const previous = previousCells[index]
    const current = currentCells[index]

    if (!previous && current) {
      diffs.push({
        index,
        status: "added",
        currentType: current.type || "unknown",
        currentPreview: extractNotebookBlockPreview(current),
      })
      continue
    }

    if (previous && !current) {
      diffs.push({
        index,
        status: "removed",
        previousType: previous.type || "unknown",
        previousPreview: extractNotebookBlockPreview(previous),
      })
      continue
    }

    if (!previous || !current) continue

    if ((previous.type || "unknown") !== (current.type || "unknown")) {
      diffs.push({
        index,
        status: "type-changed",
        previousType: previous.type || "unknown",
        currentType: current.type || "unknown",
        previousPreview: extractNotebookBlockPreview(previous),
        currentPreview: extractNotebookBlockPreview(current),
      })
      continue
    }

    const previousPreview = extractNotebookBlockPreview(previous)
    const currentPreview = extractNotebookBlockPreview(current)
    diffs.push({
      index,
      status: JSON.stringify(previous) === JSON.stringify(current) ? "unchanged" : "changed",
      previousType: previous.type || "unknown",
      currentType: current.type || "unknown",
      previousPreview,
      currentPreview,
    })
  }

  return diffs
}

export function getGalaxyNodeRevisionDiff(
  current: Pick<GalaxyNode, "title" | "content" | "tags" | "position" | "size" | "metadata" | "type" | "category" | "parentId">,
  previous: Pick<GalaxyNodeSnapshot, "title" | "content" | "tags" | "position" | "size" | "metadata" | "type" | "category" | "parentId">,
): GalaxyNodeRevisionDiff {
  const changedFields: string[] = []
  if (current.title !== previous.title) changedFields.push("title")
  if (current.content !== previous.content) changedFields.push("content")
  if (current.type !== previous.type) changedFields.push("type")
  if (current.category !== previous.category) changedFields.push("category")
  if (current.parentId !== previous.parentId) changedFields.push("parentId")
  if (stableStringify(current.tags || []) !== stableStringify(previous.tags || [])) changedFields.push("tags")
  if (stableStringify(current.position) !== stableStringify(previous.position)) changedFields.push("position")
  if (stableStringify(current.size) !== stableStringify(previous.size)) changedFields.push("size")
  if (stableStringify(current.metadata || {}) !== stableStringify(previous.metadata || {})) changedFields.push("metadata")

  if (changedFields.includes("content")) {
    const prevCells = parseNotebookCellArray(previous.content)
    const currentCells = parseNotebookCellArray(current.content)
    if (prevCells && currentCells) {
      return {
        ...formatNotebookDiff(previous.content, current.content),
        changedFields,
      }
    }
  }

  const summaryLines: string[] = []
  if (changedFields.includes("title")) {
    summaryLines.push(`Title: ${previous.title || "Untitled"} -> ${current.title || "Untitled"}`)
  }
  if (changedFields.includes("content")) {
    summaryLines.push("Text content changed.")
  }
  if (changedFields.includes("tags")) {
    summaryLines.push(`Tags: ${(previous.tags || []).join(", ") || "none"} -> ${(current.tags || []).join(", ") || "none"}`)
  }
  if (changedFields.includes("position") || changedFields.includes("size")) {
    summaryLines.push("Canvas layout changed.")
  }
  if (changedFields.includes("metadata")) {
    summaryLines.push("Metadata changed.")
  }
  if (changedFields.includes("type") || changedFields.includes("category") || changedFields.includes("parentId")) {
    summaryLines.push("Node structure changed.")
  }

  if (summaryLines.length === 0) {
    summaryLines.push("This revision matches the current node.")
  }

  return {
    changedFields,
    summaryLines,
    beforePreview: createTextPreview(previous.content),
    afterPreview: createTextPreview(current.content),
  }
}

function summarizeNodeRevision(previous: GalaxyNode, next: GalaxyNode, changedFields: string[]): string {
  if (changedFields.length === 0) return "No changes"
  if (changedFields.includes("content")) {
    const prevCells = parseNotebookCellArray(previous.content)
    const nextCells = parseNotebookCellArray(next.content)
    if (prevCells && nextCells) {
      if (prevCells.length !== nextCells.length) {
        return `Notebook structure updated (${prevCells.length} → ${nextCells.length} blocks)`
      }
      const prevKinds = prevCells.map((cell) => cell.type || "unknown").join("|")
      const nextKinds = nextCells.map((cell) => cell.type || "unknown").join("|")
      if (prevKinds !== nextKinds) {
        return "Notebook block types updated"
      }
      return `Notebook block content updated (${nextCells.length} blocks)`
    }
    if (changedFields.includes("title")) return "Title and text content updated"
    return "Text content updated"
  }
  if (changedFields.includes("position") || changedFields.includes("size")) {
    return "Canvas layout updated"
  }
  if (changedFields.includes("tags")) return "Tags updated"
  if (changedFields.includes("metadata")) return "Metadata updated"
  if (changedFields.includes("title")) return "Title updated"
  if (changedFields.includes("parentId")) return "Location updated"
  return `Updated ${changedFields.join(", ")}`
}

// Maps galaxy node types to weaviate NodeType
function toWeaviateType(type: string): "note" | "document" | "image" | "video" | "audio" | "3d" | "code" | "flow" | "canvas" | "link" | "folder" {
  const map: Record<string, any> = {
    note: "note", document: "document", image: "image", video: "video",
    audio: "audio", "3d": "3d", code: "code", jupyter: "code",
    drawing: "canvas", whiteboard: "canvas", "ai-chat": "note",
    "ai-workflow": "flow", prompt: "note", template: "document",
    "canvas-note": "note",
    folder: "folder",
  }
  return map[type] || "note"
}

class GalaxyBrainService {
  private nodes: Map<string, GalaxyNode> = new Map()
  private nodeHistory: Map<string, GalaxyNodeRevision[]> = new Map()
  private pendingRevisionSync: Map<string, GalaxyNodeRevision> = new Map()
  private historyHydrationPromises: Map<string, Promise<GalaxyNodeRevision[]>> = new Map()
  private workspaces: Map<string, GalaxyWorkspace> = new Map()
  private flows: Map<string, GalaxyFlow> = new Map()
  private userPreferences: UserPreferences = {}
  private tenantId: string | null = null

  setTenantScope(tenantId: string): void {
    if (this.tenantId === tenantId) return
    if (_saveTimer !== null) clearTimeout(_saveTimer)
    if (_revisionSyncTimer !== null) clearTimeout(_revisionSyncTimer)
    _saveTimer = null
    _revisionSyncTimer = null
    this.nodes.clear()
    this.nodeHistory.clear()
    this.pendingRevisionSync.clear()
    this.historyHydrationPromises.clear()
    this.workspaces.clear()
    this.flows.clear()
    this.userPreferences = {}
    this.tenantId = tenantId
    if (typeof window !== "undefined") {
      migrateDefaultTenantStorage(window.localStorage, tenantId, [
        "galaxy-brain-nodes",
        "galaxy-brain-node-history",
        "galaxy-brain-workspaces",
        "galaxy-brain-flows",
        "galaxy-brain-preferences",
        "knowledgeGraphNodes",
      ])
    }
    weaviateService.setTenantScope(tenantId)
    this.loadFromStorage()
  }

  private storageKey(baseKey: string): string | null {
    return this.tenantId ? tenantStorageKey(baseKey, this.tenantId) : null
  }

  // User preferences
  getUserPreferences(): UserPreferences {
    return this.userPreferences
  }

  updateUserPreferences(preferences: Partial<UserPreferences>): void {
    this.userPreferences = { ...this.userPreferences, ...preferences }
    this.saveToStorage()
  }

  trackNodeInteraction(nodeId: string, action: string): void {
    const prefs = this.userPreferences as Record<string, any>
    prefs.lastInteraction = { nodeId, action, timestamp: new Date().toISOString() }
    const history: Array<{ nodeId: string; action: string; timestamp: string }> = prefs.interactionHistory || []
    history.unshift({ nodeId, action, timestamp: new Date().toISOString() })
    prefs.interactionHistory = history.slice(0, 100)
    this.userPreferences = prefs as UserPreferences
    this.saveToStorage()
  }

  private createSnapshot(node: GalaxyNode): GalaxyNodeSnapshot {
    return normalizeRevisionSnapshot({
      type: node.type,
      title: node.title,
      content: node.content,
      category: node.category,
      parentId: node.parentId,
      position: { ...node.position },
      size: { ...node.size },
      tags: [...(node.tags || [])],
      metadata: { ...(node.metadata || {}) },
      version: node.version || 1,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
    })
  }

  private toRevisionRecord(revision: GalaxyNodeRevision): Omit<NodeRevisionRecord, "created_at"> {
    return {
      id: revision.id,
      node_id: revision.nodeId,
      version: revision.version,
      timestamp: revision.timestamp,
      source: revision.source,
      summary: revision.summary,
      changed_fields: revision.changedFields,
      snapshot_json: revision.snapshot,
    }
  }

  private fromRevisionRecord(record: NodeRevisionRecord): GalaxyNodeRevision {
    return {
      id: record.id,
      nodeId: record.node_id,
      version: typeof record.version === "number" ? record.version : 1,
      timestamp: record.timestamp,
      source: record.source || "update",
      summary: record.summary || "",
      changedFields: Array.isArray(record.changed_fields) ? record.changed_fields : [],
      snapshot: normalizeRevisionSnapshot(record.snapshot_json),
    }
  }

  private mergeNodeHistory(nodeId: string, incoming: GalaxyNodeRevision[]): GalaxyNodeRevision[] {
    const merged = new Map<string, GalaxyNodeRevision>()
    for (const revision of [...incoming, ...(this.nodeHistory.get(nodeId) || [])]) {
      if (!merged.has(revision.id)) {
        merged.set(revision.id, {
          ...revision,
          snapshot: normalizeRevisionSnapshot(revision.snapshot),
          changedFields: Array.isArray(revision.changedFields) ? revision.changedFields : [],
          version: typeof revision.version === "number" ? revision.version : 1,
        })
      }
    }
    const sorted = Array.from(merged.values())
      .sort((a, b) => (
        b.timestamp.localeCompare(a.timestamp) ||
        b.version - a.version ||
        b.id.localeCompare(a.id)
      ))
      .slice(0, HISTORY_LIMIT)
    this.nodeHistory.set(nodeId, sorted)
    return sorted
  }

  private queueRevisionSync(revision: GalaxyNodeRevision): void {
    if (typeof window === "undefined") return
    this.pendingRevisionSync.set(revision.id, revision)
    if (_revisionSyncTimer !== null) return
    _revisionSyncTimer = setTimeout(() => {
      _revisionSyncTimer = null
      void this.flushPendingRevisionSync()
    }, 250)
  }

  private async flushPendingRevisionSync(): Promise<void> {
    if (this.pendingRevisionSync.size === 0) return
    const revisions = Array.from(this.pendingRevisionSync.values())
    this.pendingRevisionSync.clear()
    try {
      await galaxyBrainAPI.upsertNodeRevisions(revisions.map((revision) => this.toRevisionRecord(revision)))
    } catch {
      for (const revision of revisions) {
        this.pendingRevisionSync.set(revision.id, revision)
      }
    }
  }

  private appendRevision(node: GalaxyNode, source: string, summary: string, changedFields: string[]): GalaxyNodeRevision {
    const existing = this.nodeHistory.get(node.id) || []
    const revision: GalaxyNodeRevision = {
      id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      nodeId: node.id,
      version: node.version || 1,
      timestamp: new Date().toISOString(),
      source,
      summary,
      changedFields,
      snapshot: this.createSnapshot(node),
    }
    this.nodeHistory.set(node.id, [revision, ...existing].slice(0, HISTORY_LIMIT))
    this.queueRevisionSync(revision)
    return revision
  }

  private getChangedFields(previous: GalaxyNode, next: GalaxyNode): string[] {
    const changed: string[] = []
    if (previous.type !== next.type) changed.push("type")
    if (previous.title !== next.title) changed.push("title")
    if (previous.content !== next.content) changed.push("content")
    if (previous.category !== next.category) changed.push("category")
    if (previous.parentId !== next.parentId) changed.push("parentId")
    if (stableStringify(previous.position) !== stableStringify(next.position)) changed.push("position")
    if (stableStringify(previous.size) !== stableStringify(next.size)) changed.push("size")
    if (stableStringify(previous.tags || []) !== stableStringify(next.tags || [])) changed.push("tags")
    if (stableStringify(previous.metadata || {}) !== stableStringify(next.metadata || {})) changed.push("metadata")
    return changed
  }

  // Node management
  createNode(
    type: string,
    title: string,
    content: string,
    category: "ai" | "document" | "media" | "speech" | "knowledge",
    parentId: string | null = null,
    position: { x: number; y: number } = { x: 0, y: 0 },
    size: { width: number; height: number } = { width: 300, height: 200 }
  ): GalaxyNode {
    const node: GalaxyNode = {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      title,
      content,
      category,
      parentId,
      position,
      size,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    this.nodes.set(node.id, node)
    this.appendRevision(node, "create", "Node created", ["create"])
    this.saveToStorage()
    this.syncToKnowledgeBase(node)
    return node
  }

  createCanvasNote(
    parentId: string | null,
    position: { x: number; y: number },
    title = "Untitled Note",
    content = "",
    size: { width: number; height: number } = { width: 340, height: 220 },
  ): GalaxyNode {
    const componentId = `component_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const node = this.createNode(
      "canvas-note",
      title,
      content,
      "knowledge",
      parentId,
      position,
      size,
    )
    const metadata: CanvasComponentMetadata = {
      componentType: "RichText",
      shareTargetId: componentId,
      shareTargetType: "component",
    }
    return this.updateNode(node.id, {
      metadata: { ...node.metadata, ...metadata },
    }) || node
  }

  getNode(id: string): GalaxyNode | undefined {
    return this.nodes.get(id)
  }

  getNodes(): GalaxyNode[] {
    return Array.from(this.nodes.values())
  }

  getNodeHistory(nodeId: string): GalaxyNodeRevision[] {
    return this.nodeHistory.get(nodeId) || []
  }

  async pinNodeRevisionForShare(nodeId: string): Promise<{ nodeId: string; revisionId: string }> {
    const node = this.nodes.get(nodeId)
    if (!node) throw new Error("Node not found")
    const revision = this.getNodeHistory(nodeId)[0]
      || this.appendRevision(node, "share", "Node pinned for sharing", ["share"])
    const upserted = await galaxyBrainAPI.upsertNodeRevisions([this.toRevisionRecord(revision)])
    if (upserted !== 1) throw new Error("Node revision could not be pinned")
    this.pendingRevisionSync.delete(revision.id)
    return { nodeId, revisionId: revision.id }
  }

  async hydrateNodeHistory(nodeId: string): Promise<GalaxyNodeRevision[]> {
    if (typeof window === "undefined") {
      return this.getNodeHistory(nodeId)
    }
    const existing = this.historyHydrationPromises.get(nodeId)
    if (existing) {
      return existing
    }
    const tenantId = this.tenantId
    const task = (async () => {
      try {
        const remoteRevisions = await galaxyBrainAPI.getNodeRevisions(nodeId)
        if (this.tenantId !== tenantId) return this.getNodeHistory(nodeId)
        if (remoteRevisions.length > 0) {
          const merged = this.mergeNodeHistory(nodeId, remoteRevisions.map((record) => this.fromRevisionRecord(record)))
          this.saveToStorage()
          return merged
        }
      } catch {}
      return this.getNodeHistory(nodeId)
    })()
    this.historyHydrationPromises.set(nodeId, task)
    try {
      return await task
    } finally {
      if (this.historyHydrationPromises.get(nodeId) === task) {
        this.historyHydrationPromises.delete(nodeId)
      }
    }
  }

  findNodeByDatasourceOrigin(datasourceId: string, datasourceItemId: string): GalaxyNode | undefined {
    return Array.from(this.nodes.values()).find((node) => (
      node.metadata?.datasourceId === datasourceId &&
      node.metadata?.datasourceItemId === datasourceItemId
    ))
  }

  updateNode(id: string, updates: Partial<GalaxyNode>, options: UpdateNodeOptions = {}): GalaxyNode | null {
    const node = this.nodes.get(id)
    if (!node) return null

    const updatedNode = {
      ...node,
      ...updates,
      version: (node.version || 1) + 1,
      updatedAt: new Date(),
    }
    const changedFields = this.getChangedFields(node, updatedNode)
    if (changedFields.length === 0) return node
    this.nodes.set(id, updatedNode)
    if (!options.skipHistory) {
      this.appendRevision(
        updatedNode,
        options.changeSource || "update",
        summarizeNodeRevision(node, updatedNode, changedFields),
        changedFields,
      )
    }
    this.saveToStorage()
    this.syncToKnowledgeBase(updatedNode)
    return updatedNode
  }

  restoreNodeRevision(nodeId: string, revisionId: string): GalaxyNode | null {
    const node = this.nodes.get(nodeId)
    const revision = this.getNodeHistory(nodeId).find((entry) => entry.id === revisionId)
    if (!node || !revision) return null
    return this.updateNode(
      nodeId,
      {
        type: revision.snapshot.type,
        title: revision.snapshot.title,
        content: revision.snapshot.content,
        category: revision.snapshot.category,
        parentId: revision.snapshot.parentId,
        position: { ...revision.snapshot.position },
        size: { ...revision.snapshot.size },
        tags: [...revision.snapshot.tags],
        metadata: { ...revision.snapshot.metadata },
      },
      { changeSource: "restore" },
    )
  }

  deleteNode(id: string): boolean {
    const node = this.nodes.get(id)
    const deleted = this.nodes.delete(id)
    if (deleted) {
      if (node) {
        this.appendRevision(
          {
            ...node,
            version: (node.version || 1) + 1,
            updatedAt: new Date(),
          },
          "delete",
          "Node deleted",
          ["delete"],
        )
      }
      this.saveToStorage()
      // Also delete from knowledge base
      try {
        weaviateService.deleteNode(id)
      } catch {}
    }
    return deleted
  }

  /** Mirror a galaxy node to the weaviate knowledge base for search/processing */
  private syncToKnowledgeBase(node: GalaxyNode): void {
    try {
      const existing = weaviateService.getNode(node.id)
      if (existing) {
        weaviateService.updateNode(node.id, {
          title: node.title,
          content: node.content,
          tags: node.tags || [],
          metadata: { ...node.metadata, galaxyCategory: node.category, galaxyType: node.type },
        })
      } else {
        // Create a new knowledge base node under the galaxy node's own ID, so
        // the two records can be matched back up (the graph resolves a click
        // by looking the knowledge node's id up among the galaxy nodes).
        weaviateService.upsertNodeWithId({
          id: node.id,
          type: toWeaviateType(node.type),
          title: node.title,
          content: node.content,
          tags: node.tags || [],
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          position: node.position,
          size: node.size,
          parentId: node.parentId || undefined,
          metadata: { ...node.metadata, galaxyCategory: node.category, galaxyType: node.type },
        })
      }
    } catch {
      // Sync is best-effort — don't break the main flow
    }
  }

  // Workspace management
  createWorkspace(name: string, description?: string): GalaxyWorkspace {
    const rootFolder = this.createNode("folder", "Root", "", "knowledge")
    
    const workspace: GalaxyWorkspace = {
      id: `workspace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      description,
      rootFolderId: rootFolder.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    this.workspaces.set(workspace.id, workspace)
    this.saveToStorage()
    return workspace
  }

  getWorkspaces(): GalaxyWorkspace[] {
    return Array.from(this.workspaces.values())
  }

  getWorkspace(id: string): GalaxyWorkspace | undefined {
    return this.workspaces.get(id)
  }

  // Flow management
  createFlow(name: string, workspaceId: string, description?: string): GalaxyFlow {
    const flow: GalaxyFlow = {
      id: `flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      description,
      workspaceId,
      nodes: [],
      edges: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    this.flows.set(flow.id, flow)
    this.saveToStorage()
    return flow
  }

  getWorkspaceFlows(workspaceId: string): GalaxyFlow[] {
    return Array.from(this.flows.values()).filter(flow => flow.workspaceId === workspaceId)
  }

  // Storage
  private saveToStorage(): void {
    if (typeof window === 'undefined') return
    const nodesKey = this.storageKey('galaxy-brain-nodes')
    const historyKey = this.storageKey('galaxy-brain-node-history')
    const workspacesKey = this.storageKey('galaxy-brain-workspaces')
    const flowsKey = this.storageKey('galaxy-brain-flows')
    const preferencesKey = this.storageKey('galaxy-brain-preferences')
    if (!nodesKey || !historyKey || !workspacesKey || !flowsKey || !preferencesKey) return
    if (_saveTimer !== null) clearTimeout(_saveTimer)
    _saveTimer = setTimeout(() => {
      _saveTimer = null
      localStorage.setItem(nodesKey, JSON.stringify(Array.from(this.nodes.entries())))
      localStorage.setItem(historyKey, JSON.stringify(Array.from(this.nodeHistory.entries())))
      localStorage.setItem(workspacesKey, JSON.stringify(Array.from(this.workspaces.entries())))
      localStorage.setItem(flowsKey, JSON.stringify(Array.from(this.flows.entries())))
      localStorage.setItem(preferencesKey, JSON.stringify(this.userPreferences))
    }, 100)
  }

  private loadFromStorage(): void {
    if (typeof window !== 'undefined') {
      try {
        const nodesKey = this.storageKey('galaxy-brain-nodes')
        const historyKey = this.storageKey('galaxy-brain-node-history')
        const workspacesKey = this.storageKey('galaxy-brain-workspaces')
        const flowsKey = this.storageKey('galaxy-brain-flows')
        const preferencesKey = this.storageKey('galaxy-brain-preferences')
        const knowledgeNodesKey = this.storageKey('knowledgeGraphNodes')
        if (!nodesKey || !historyKey || !workspacesKey || !flowsKey || !preferencesKey || !knowledgeNodesKey) return
        let seededHistory = false
        const nodesData = localStorage.getItem(nodesKey)
        if (nodesData) {
          const entries = JSON.parse(nodesData)
          const MAX_CONTENT = 500_000
          let pruned = 0
          const safeEntries = entries.filter(([, node]: [string, any]) => {
            const c = node?.content
            const bad =
              typeof c === 'string' &&
              (c.startsWith('%PDF') ||
                c.length > MAX_CONTENT ||
                /— read failed$/.test(c) ||
                /^\[application\/pdf\].*read failed/.test(c))
            if (bad) pruned++
            return !bad
          })
          if (pruned > 0) {
            console.warn(`[galaxy-brain] Pruned ${pruned} oversized/binary node(s) on load`)
          }
          this.nodes = new Map(safeEntries.map(([id, node]: [string, any]) => [
            id,
            {
              ...node,
              version: typeof node.version === "number" && node.version > 0 ? node.version : 1,
              createdAt: new Date(node.createdAt),
              updatedAt: new Date(node.updatedAt),
            }
          ]))
          if (pruned > 0) {
            localStorage.setItem(
              nodesKey,
              JSON.stringify(Array.from(this.nodes.entries())),
            )
            try {
              const kraw = localStorage.getItem(knowledgeNodesKey)
              if (kraw) {
                const knodes = JSON.parse(kraw)
                const kclean = knodes.filter(
                  (n: any) =>
                    !(typeof n?.content === 'string' &&
                      (n.content.startsWith('%PDF') || n.content.length > MAX_CONTENT)),
                )
                localStorage.setItem(knowledgeNodesKey, JSON.stringify(kclean))
              }
            } catch {}
          }
        }

        const historyData = localStorage.getItem(historyKey)
        if (historyData) {
          const entries = JSON.parse(historyData)
          this.nodeHistory = new Map(entries.map(([id, revisions]: [string, GalaxyNodeRevision[]]) => [
            id,
            (revisions || []).map((revision: any) => ({
              ...revision,
              nodeId: revision.nodeId || revision.node_id || id,
              changedFields: Array.isArray(revision.changedFields) ? revision.changedFields : (revision.changed_fields || []),
              snapshot: normalizeRevisionSnapshot(revision.snapshot),
            })),
          ]))
        }

        const workspacesData = localStorage.getItem(workspacesKey)
        if (workspacesData) {
          const entries = JSON.parse(workspacesData)
          this.workspaces = new Map(entries.map(([id, workspace]: [string, any]) => [
            id,
            { ...workspace, createdAt: new Date(workspace.createdAt), updatedAt: new Date(workspace.updatedAt) }
          ]))
        }

        const flowsData = localStorage.getItem(flowsKey)
        if (flowsData) {
          const entries = JSON.parse(flowsData)
          this.flows = new Map(entries.map(([id, flow]: [string, any]) => [
            id,
            { ...flow, createdAt: new Date(flow.createdAt), updatedAt: new Date(flow.updatedAt) }
          ]))
        }

        const preferencesData = localStorage.getItem(preferencesKey)
        if (preferencesData) {
          this.userPreferences = JSON.parse(preferencesData)
        }

        for (const node of this.nodes.values()) {
          if ((this.nodeHistory.get(node.id) || []).length === 0) {
            this.appendRevision(node, "bootstrap", "Version tracking initialized", ["bootstrap"])
            seededHistory = true
          }
        }
        for (const revisions of this.nodeHistory.values()) {
          for (const revision of revisions) {
            this.queueRevisionSync(revision)
          }
        }
        if (seededHistory) {
          localStorage.setItem(historyKey, JSON.stringify(Array.from(this.nodeHistory.entries())))
        }
      } catch (error) {
        console.error('Error loading from storage:', error)
      }
    }
  }

  initializeWithDemoData(): void {
    if (this.workspaces.size === 0) {
      const workspace = this.createWorkspace("My Galaxy Brain", "Default workspace for notes and AI workflows")
      
      // Create some demo nodes
      this.createNode("note", "Welcome to Galaxy Brain", "This is your first note in Galaxy Brain!", "knowledge", workspace.rootFolderId, { x: 100, y: 100 })
      this.createNode("document", "Research Notes", "Collect your research findings here.", "document", workspace.rootFolderId, { x: 300, y: 200 })
      this.createNode("ai-workflow", "Text Summarizer", "AI workflow for summarizing documents", "ai", workspace.rootFolderId, { x: 500, y: 150 })
    }
  }
}

export const galaxyBrainService = new GalaxyBrainService()

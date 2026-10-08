/**
 * HAM Service — optional memory backend plugin.
 *
 * Connects to any compatible HAM API server through the authenticated plugin proxy.
 * The HAM implementation is not vendored in this repo; see HAM_PLUGIN.md.
 *
 * Compatible with the existing WeaviateService interface used by the frontend.
 */

import { safeUnscopedLocalStorage } from "./browser-utils"
import { searchHam } from "./ham-search-client"
import { migrateDefaultTenantStorage, tenantStorageKey } from "./tenant-browser-storage"

export type NodeType = "note" | "document" | "image" | "video" | "audio" | "3d" | "code" | "flow" | "canvas" | "link" | "folder"

export type KnowledgeNode = {
  id: string
  type: NodeType
  title: string
  content: string
  tags: string[]
  createdAt: Date
  updatedAt: Date
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  parentId?: string
  metadata?: Record<string, any>
}

export type KnowledgeEdge = {
  id: string
  source: string
  target: string
  label?: string
  strength?: number
  createdAt: Date
  metadata?: Record<string, any>
}

export type SearchResult = {
  node: KnowledgeNode
  score: number
  relatedNodes: Array<{ node: KnowledgeNode; similarity: number }>
}

export type Workspace = {
  id: string
  name: string
  description?: string
  rootFolderId: string
  createdAt: Date
  updatedAt: Date
}

const HAM_API = "/api/plugins/ham"

// Local cache for nodes (synced with HAM backend)
class HAMService {
  private readonly LOCAL_NODES_KEY = "hamNodes"
  private readonly LOCAL_EDGES_KEY = "hamEdges"
  private readonly WORKSPACES_KEY = "hamWorkspaces"
  private readonly USER_PREFERENCES_KEY = "userPreferences"
  private tenantId: string | null = null

  public setTenantScope(tenantId: string): void {
    if (this.tenantId === tenantId) return
    this.tenantId = tenantId
    migrateDefaultTenantStorage(safeUnscopedLocalStorage(), tenantId, [
      this.LOCAL_NODES_KEY,
      this.LOCAL_EDGES_KEY,
      this.WORKSPACES_KEY,
      this.USER_PREFERENCES_KEY,
    ])
  }

  private storageKey(baseKey: string): string | null {
    return this.tenantId ? tenantStorageKey(baseKey, this.tenantId) : null
  }

  private getStored(baseKey: string): string | null {
    const key = this.storageKey(baseKey)
    return key ? safeUnscopedLocalStorage().getItem(key) : null
  }

  private setStored(baseKey: string, value: string): void {
    const key = this.storageKey(baseKey)
    if (key) safeUnscopedLocalStorage().setItem(key, value)
  }

  // --- HAM API calls ---

  private async hamFetch(path: string, options?: RequestInit) {
    const res = await fetch(`${HAM_API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    })
    if (!res.ok) {
      console.error(`HAM API error: ${res.status} ${res.statusText}`)
      return null
    }
    return res.json()
  }

  private async hamIngest(content: string, title: string, type: string, tags: string[], metadata?: Record<string, any>) {
    return this.hamFetch("/ingest", {
      method: "POST",
      body: JSON.stringify({
        content,
        title,
        type,
        cues: tags.length > 0 ? tags : undefined,
        metadata: { ...metadata, title },
      }),
    })
  }

  private async hamSearch(query: string, topK = 10): Promise<any[]> {
    return searchHam({ query, mode: "search", topK })
  }

  private async hamSearchMultihop(query: string, topK = 10, maxHops = 1): Promise<any[]> {
    return searchHam({ query, mode: "multihop", topK, maxHops })
  }

  public async hamConsolidate() {
    return this.hamFetch("/consolidate", { method: "POST" })
  }

  /**
   * Enrich a HAM memory with tags and summary.
   * Called after client-side processing extracts keywords/summary,
   * as a fallback if the server-side BitNet enrichment is unavailable.
   */
  public async hamEnrich(memoryId: number, tags: string[], summary: string): Promise<any> {
    return this.hamFetch(`/enrich/${memoryId}`, {
      method: "POST",
      body: JSON.stringify({ tags, summary }),
    })
  }

  public async hamStats() {
    return this.hamFetch("/stats")
  }

  public async hamFieldStats(): Promise<any> {
    return this.hamFetch("/field/stats")
  }

  public async hamDeleteMemory(memoryId: number): Promise<any> {
    return this.hamFetch(`/memories/${memoryId}`, { method: "DELETE" })
  }

  public async hamReset(): Promise<any> {
    return this.hamFetch("/reset", { method: "DELETE" })
  }

  public async hamSearchFused(query: string, topK = 10, timeStart?: string, timeEnd?: string): Promise<any[]> {
    void timeStart
    void timeEnd
    return searchHam({ query, mode: "search", topK })
  }

  public async hamChat(query: string, history?: Array<{ role: "user" | "assistant"; content: string }>, topK = 5): Promise<{ response: string; sources: any[]; used_bitnet: boolean } | null> {
    return this.hamFetch("/chat", {
      method: "POST",
      body: JSON.stringify({ query, history, top_k: topK }),
    })
  }

  // --- Local node storage (for UI state: positions, folders, etc.) ---
  // HAM stores content + embeddings; local storage keeps UI-specific data

  private getLocalNodes(): KnowledgeNode[] {
    const json = this.getStored(this.LOCAL_NODES_KEY)
    if (!json) return []
    try {
      return JSON.parse(json).map((n: any) => ({
        ...n,
        createdAt: new Date(n.createdAt),
        updatedAt: new Date(n.updatedAt),
      }))
    } catch { return [] }
  }

  private saveLocalNodes(nodes: KnowledgeNode[]) {
    this.setStored(this.LOCAL_NODES_KEY, JSON.stringify(nodes))
  }

  // --- WeaviateService-compatible interface ---

  public getNodes(): KnowledgeNode[] {
    return this.getLocalNodes()
  }

  public getEdges(): KnowledgeEdge[] {
    const json = this.getStored(this.LOCAL_EDGES_KEY)
    if (!json) return []
    try {
      return JSON.parse(json).map((e: any) => ({
        ...e,
        createdAt: new Date(e.createdAt),
      }))
    } catch { return [] }
  }

  public getWorkspaces(): Workspace[] {
    const json = this.getStored(this.WORKSPACES_KEY)
    if (!json) return []
    try {
      return JSON.parse(json).map((w: any) => ({
        ...w,
        createdAt: new Date(w.createdAt),
        updatedAt: new Date(w.updatedAt),
      }))
    } catch { return [] }
  }

  public getNode(id: string): KnowledgeNode | null {
    return this.getLocalNodes().find((n) => n.id === id) || null
  }

  public getNodeEdges(nodeId: string): KnowledgeEdge[] {
    return this.getEdges().filter((e) => e.source === nodeId || e.target === nodeId)
  }

  public getWorkspace(id: string): Workspace | null {
    return this.getWorkspaces().find((w) => w.id === id) || null
  }

  public createNode(
    type: NodeType,
    title: string,
    content = "",
    parentId?: string,
    position?: { x: number; y: number },
    size?: { width: number; height: number },
    tags: string[] = [],
    metadata: Record<string, any> = {},
  ): KnowledgeNode {
    const now = new Date()
    const node: KnowledgeNode = {
      id: `node-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type, title, content, tags,
      createdAt: now, updatedAt: now,
      position, size, parentId, metadata,
    }

    // Save locally
    const nodes = this.getLocalNodes()
    this.saveLocalNodes([...nodes, node])

    // Ingest into HAM (async, don't block UI)
    if (content && type !== "folder") {
      this.hamIngest(content, title, type, tags, { ...metadata, nodeId: node.id })
        .then((result) => {
          if (result?.id) {
            // Store HAM memory ID in node metadata for enrichment
            const nodes = this.getLocalNodes()
            const idx = nodes.findIndex((n) => n.id === node.id)
            if (idx >= 0) {
              nodes[idx] = {
                ...nodes[idx],
                metadata: { ...nodes[idx].metadata, hamMemoryId: result.id },
              }
              this.saveLocalNodes(nodes)
            }
          }
        })
        .catch((err) => console.error("HAM ingest failed:", err))
    }

    return node
  }

  public createEdge(
    source: string,
    target: string,
    label?: string,
    strength = 1,
    metadata: Record<string, any> = {},
  ): KnowledgeEdge {
    const edge: KnowledgeEdge = {
      id: `edge-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      source, target, label, strength,
      createdAt: new Date(), metadata,
    }
    const edges = this.getEdges()
    this.setStored(this.LOCAL_EDGES_KEY, JSON.stringify([...edges, edge]))
    return edge
  }

  public createWorkspace(name: string, description?: string): Workspace {
    const rootFolder = this.createNode("folder", name, "", undefined, undefined, undefined, [], { isRoot: true })
    const workspace: Workspace = {
      id: `workspace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name, description,
      rootFolderId: rootFolder.id,
      createdAt: new Date(), updatedAt: new Date(),
    }
    const workspaces = this.getWorkspaces()
    this.setStored(this.WORKSPACES_KEY, JSON.stringify([...workspaces, workspace]))
    return workspace
  }

  /**
   * Insert a node under a caller-supplied id, preserving it.
   *
   * createNode() mints its own id, which breaks callers that mirror an
   * existing record (galaxyBrainService) and then need to match the two
   * back up by id. This writes through saveLocalNodes so the node lands
   * in the same store getNodes() reads.
   */
  public upsertNodeWithId(node: KnowledgeNode): KnowledgeNode {
    const nodes = this.getLocalNodes()
    const index = nodes.findIndex((n) => n.id === node.id)
    if (index >= 0) {
      nodes[index] = { ...nodes[index], ...node }
      this.saveLocalNodes(nodes)
      return nodes[index]
    }
    this.saveLocalNodes([...nodes, node])
    return node
  }

  public updateNode(id: string, updates: Partial<Omit<KnowledgeNode, "id" | "createdAt">>): KnowledgeNode | null {
    const nodes = this.getLocalNodes()
    const index = nodes.findIndex((n) => n.id === id)
    if (index === -1) return null

    const updated = { ...nodes[index], ...updates, updatedAt: new Date() }
    nodes[index] = updated
    this.saveLocalNodes(nodes)

    // Re-ingest into HAM if content changed
    if (updates.content && updated.type !== "folder") {
      this.hamIngest(
        updates.content || updated.content,
        updated.title,
        updated.type,
        updated.tags,
        { ...updated.metadata, nodeId: id },
      ).catch((err) => console.error("HAM re-ingest failed:", err))
    }

    return updated
  }

  public updateEdge(id: string, updates: Partial<Omit<KnowledgeEdge, "id" | "createdAt">>): KnowledgeEdge | null {
    const edges = this.getEdges()
    const index = edges.findIndex((e) => e.id === id)
    if (index === -1) return null
    edges[index] = { ...edges[index], ...updates }
    this.setStored(this.LOCAL_EDGES_KEY, JSON.stringify(edges))
    return edges[index]
  }

  public updateWorkspace(id: string, updates: Partial<Omit<Workspace, "id" | "createdAt">>): Workspace | null {
    const workspaces = this.getWorkspaces()
    const index = workspaces.findIndex((w) => w.id === id)
    if (index === -1) return null
    workspaces[index] = { ...workspaces[index], ...updates, updatedAt: new Date() }
    this.setStored(this.WORKSPACES_KEY, JSON.stringify(workspaces))
    return workspaces[index]
  }

  public deleteNode(id: string): boolean {
    const nodes = this.getLocalNodes()
    const toDelete = nodes.find((n) => n.id === id)
    const filtered = nodes.filter((n) => n.id !== id)
    if (filtered.length === nodes.length) return false
    this.saveLocalNodes(filtered)
    // Also delete connected edges
    const edges = this.getEdges().filter((e) => e.source !== id && e.target !== id)
    this.setStored(this.LOCAL_EDGES_KEY, JSON.stringify(edges))
    // Clean up HAM backend record
    const hamMemoryId = toDelete?.metadata?.hamMemoryId
    if (typeof hamMemoryId === "number") {
      this.hamDeleteMemory(hamMemoryId).catch((err) => console.error("HAM delete failed:", err))
    }
    return true
  }

  public deleteEdge(id: string): boolean {
    const edges = this.getEdges()
    const filtered = edges.filter((e) => e.id !== id)
    if (filtered.length === edges.length) return false
    this.setStored(this.LOCAL_EDGES_KEY, JSON.stringify(filtered))
    return true
  }

  // --- Search: uses HAM backend for semantic + BM25 hybrid ---

  public searchNodes(query: string, limit = 10): SearchResult[] {
    // Synchronous wrapper — falls back to local search if HAM is unavailable
    // For real async search, use searchNodesAsync()
    const nodes = this.getLocalNodes()
    if (!query.trim()) return []

    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0)

    // Local fallback search (same as original WeaviateService)
    const scored = nodes
      .map((node) => {
        const titleLower = node.title.toLowerCase()
        const contentLower = node.content.toLowerCase()
        const tagsLower = node.tags.map((t) => t.toLowerCase())
        let score = 0

        if (titleLower === queryLower) score += 10
        if (titleLower.includes(queryLower)) score += 5
        if (tagsLower.some((tag) => tag === queryLower)) score += 6

        for (const term of queryTerms) {
          if (titleLower.includes(term)) score += 3
          if (tagsLower.some((tag) => tag.includes(term))) score += 2.5
          if (contentLower.includes(term)) score += 1
        }

        return { node, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map(({ node, score }) => ({
      node,
      score,
      relatedNodes: [],
    }))
  }

  /**
   * Async search using HAM backend — fused (QKPS + Clifford + KAN) by default,
   * or multi-hop when multihop=true.
   * Call this from components that can handle async.
   */
  public async searchNodesAsync(query: string, limit = 10, multihop = false): Promise<SearchResult[]> {
    try {
      const results = multihop
        ? await this.hamSearchMultihop(query, limit, 1)
        : await this.hamSearchFused(query, limit)

      if (!results) return this.searchNodes(query, limit)
      if (results.length === 0) return []

      const nodes = this.getLocalNodes()
      return results.map((r: any) => {
        const localNode = nodes.find((n) =>
          n.content === r.content || r.metadata?.nodeId === n.id
        )

        const node: KnowledgeNode = localNode || {
          id: `ham-${r.id}`,
          type: (r.metadata?.type as NodeType) || "note",
          title: r.metadata?.title || r.content.substring(0, 60) + "...",
          content: r.content,
          tags: [],
          createdAt: r.timestamp ? new Date(r.timestamp) : new Date(),
          updatedAt: new Date(),
          metadata: { ...r.metadata, hamTier: r.tier, hamScore: r.score },
        }

        return {
          node,
          score: r.score,
          relatedNodes: [],
        }
      })
    } catch (err) {
      console.error("HAM search failed, falling back to local:", err)
      return this.searchNodes(query, limit)
    }
  }

  // --- Recommendations & Preferences ---

  public getRecommendedNodes(limit = 5): KnowledgeNode[] {
    const nodes = this.getLocalNodes()
    // Simple: return most recently updated
    return [...nodes]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
  }

  public getUserPreferences(): Record<string, any> {
    const json = this.getStored(this.USER_PREFERENCES_KEY)
    if (!json) return { recentSearches: [], recentNodes: [], viewMode: "canvas" }
    try { return JSON.parse(json) } catch { return { recentSearches: [], recentNodes: [], viewMode: "canvas" } }
  }

  public trackNodeInteraction(nodeId: string, interactionType: "view" | "edit" | "create" | "delete"): void {
    const preferences = this.getUserPreferences()
    if (!preferences.recentNodes) preferences.recentNodes = []
    preferences.recentNodes = [nodeId, ...preferences.recentNodes.filter((id: string) => id !== nodeId)].slice(0, 20)
    this.setStored(this.USER_PREFERENCES_KEY, JSON.stringify(preferences))
  }

  public updateUserPreferences(updates: Record<string, any>): void {
    const preferences = this.getUserPreferences()
    this.setStored(this.USER_PREFERENCES_KEY, JSON.stringify({ ...preferences, ...updates }))
  }

  public initializeWithDemoData(): void {
    if (this.getWorkspaces().length > 0) return

    const workspace = this.createWorkspace("My Knowledge Base", "Galaxy Brain powered by HAM")
    const rootFolder = this.getNode(workspace.rootFolderId)
    if (!rootFolder) return

    const researchFolder = this.createNode("folder", "Research", "", rootFolder.id)

    this.createNode(
      "note",
      "Welcome to Galaxy Brain",
      "This knowledge base is powered by Harmonic Addressable Memory (HAM). " +
      "Every note, document, and code snippet you add is automatically embedded " +
      "and indexed for semantic retrieval. Memories consolidate through three tiers " +
      "as you access them — frequently retrieved knowledge stays fast and relevant.\n\n" +
      "Try searching with natural language to find your memories.",
      researchFolder.id,
      { x: 100, y: 100 },
      undefined,
      ["welcome", "HAM", "knowledge-base"],
    )

    this.createNode(
      "note",
      "How HAM Memory Works",
      "HAM organizes memories in three tiers:\n\n" +
      "**Tier 1 (Recent)**: Full-fidelity entries, capacity limited. Your latest notes live here.\n\n" +
      "**Tier 2 (Episodic)**: Consolidated entries promoted by repeated access. Frequently used knowledge moves here.\n\n" +
      "**Tier 3 (Archival)**: Stable long-term knowledge. Rarely changes but always searchable.\n\n" +
      "Every search automatically tracks access patterns, driving the consolidation lifecycle.",
      researchFolder.id,
      { x: 400, y: 100 },
      undefined,
      ["HAM", "memory", "tiers", "consolidation"],
    )
  }
}

// Export singleton
export const hamService = new HAMService()

// Also export as weaviateService for backwards compatibility
export const weaviateService = hamService

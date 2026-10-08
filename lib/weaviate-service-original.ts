import { safeLocalStorage } from "./browser-utils"

// Define types for our knowledge graph
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
  parentId?: string // For folder structure
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

// Weaviate service for managing knowledge graph
export class WeaviateService {
  private readonly NODES_STORAGE_KEY = "knowledgeGraphNodes"
  private readonly EDGES_STORAGE_KEY = "knowledgeGraphEdges"
  private readonly WORKSPACES_STORAGE_KEY = "knowledgeGraphWorkspaces"
  private readonly USER_PREFERENCES_KEY = "userPreferences"

  // Get all nodes
  public getNodes(): KnowledgeNode[] {
    const nodesJson = safeLocalStorage().getItem(this.NODES_STORAGE_KEY)
    if (!nodesJson) {
      return []
    }

    try {
      const nodes = JSON.parse(nodesJson)
      return nodes.map((node: any) => ({
        ...node,
        createdAt: new Date(node.createdAt),
        updatedAt: new Date(node.updatedAt),
      }))
    } catch (error) {
      console.error("Failed to parse nodes:", error)
      return []
    }
  }

  // Get all edges
  public getEdges(): KnowledgeEdge[] {
    const edgesJson = safeLocalStorage().getItem(this.EDGES_STORAGE_KEY)
    if (!edgesJson) {
      return []
    }

    try {
      const edges = JSON.parse(edgesJson)
      return edges.map((edge: any) => ({
        ...edge,
        createdAt: new Date(edge.createdAt),
      }))
    } catch (error) {
      console.error("Failed to parse edges:", error)
      return []
    }
  }

  // Get all workspaces
  public getWorkspaces(): Workspace[] {
    const workspacesJson = safeLocalStorage().getItem(this.WORKSPACES_STORAGE_KEY)
    if (!workspacesJson) {
      return []
    }

    try {
      const workspaces = JSON.parse(workspacesJson)
      return workspaces.map((workspace: any) => ({
        ...workspace,
        createdAt: new Date(workspace.createdAt),
        updatedAt: new Date(workspace.updatedAt),
      }))
    } catch (error) {
      console.error("Failed to parse workspaces:", error)
      return []
    }
  }

  // Get a node by ID
  public getNode(id: string): KnowledgeNode | null {
    const nodes = this.getNodes()
    return nodes.find((node) => node.id === id) || null
  }

  // Get edges connected to a node
  public getNodeEdges(nodeId: string): KnowledgeEdge[] {
    const edges = this.getEdges()
    return edges.filter((edge) => edge.source === nodeId || edge.target === nodeId)
  }

  // Get a workspace by ID
  public getWorkspace(id: string): Workspace | null {
    const workspaces = this.getWorkspaces()
    return workspaces.find((workspace) => workspace.id === id) || null
  }

  // Create a new node
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
    const nodes = this.getNodes()
    const now = new Date()

    const newNode: KnowledgeNode = {
      id: `node-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      title,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      position,
      size,
      parentId,
      metadata,
    }

    safeLocalStorage().setItem(this.NODES_STORAGE_KEY, JSON.stringify([...nodes, newNode]))
    return newNode
  }

  // Create a new edge
  public createEdge(
    source: string,
    target: string,
    label?: string,
    strength = 1,
    metadata: Record<string, any> = {},
  ): KnowledgeEdge {
    const edges = this.getEdges()
    const now = new Date()

    const newEdge: KnowledgeEdge = {
      id: `edge-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      source,
      target,
      label,
      strength,
      createdAt: now,
      metadata,
    }

    safeLocalStorage().setItem(this.EDGES_STORAGE_KEY, JSON.stringify([...edges, newEdge]))
    return newEdge
  }

  // Create a new workspace
  public createWorkspace(name: string, description?: string): Workspace {
    const workspaces = this.getWorkspaces()
    const now = new Date()

    // Create root folder for the workspace
    const rootFolder = this.createNode("folder", name, "", undefined, undefined, undefined, [], { isRoot: true })

    const newWorkspace: Workspace = {
      id: `workspace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name,
      description,
      rootFolderId: rootFolder.id,
      createdAt: now,
      updatedAt: now,
    }

    safeLocalStorage().setItem(this.WORKSPACES_STORAGE_KEY, JSON.stringify([...workspaces, newWorkspace]))
    return newWorkspace
  }

  // Update a node
  public updateNode(id: string, updates: Partial<Omit<KnowledgeNode, "id" | "createdAt">>): KnowledgeNode | null {
    const nodes = this.getNodes()
    const index = nodes.findIndex((node) => node.id === id)

    if (index === -1) {
      return null
    }

    const updatedNode: KnowledgeNode = {
      ...nodes[index],
      ...updates,
      updatedAt: new Date(),
    }

    nodes[index] = updatedNode
    safeLocalStorage().setItem(this.NODES_STORAGE_KEY, JSON.stringify(nodes))
    return updatedNode
  }

  // Update an edge
  public updateEdge(id: string, updates: Partial<Omit<KnowledgeEdge, "id" | "createdAt">>): KnowledgeEdge | null {
    const edges = this.getEdges()
    const index = edges.findIndex((edge) => edge.id === id)

    if (index === -1) {
      return null
    }

    const updatedEdge: KnowledgeEdge = {
      ...edges[index],
      ...updates,
    }

    edges[index] = updatedEdge
    safeLocalStorage().setItem(this.EDGES_STORAGE_KEY, JSON.stringify(edges))
    return updatedEdge
  }

  // Update a workspace
  public updateWorkspace(id: string, updates: Partial<Omit<Workspace, "id" | "createdAt">>): Workspace | null {
    const workspaces = this.getWorkspaces()
    const index = workspaces.findIndex((workspace) => workspace.id === id)

    if (index === -1) {
      return null
    }

    const updatedWorkspace: Workspace = {
      ...workspaces[index],
      ...updates,
      updatedAt: new Date(),
    }

    workspaces[index] = updatedWorkspace
    safeLocalStorage().setItem(this.WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces))
    return updatedWorkspace
  }

  // Delete a node
  public deleteNode(id: string): boolean {
    const nodes = this.getNodes()
    const filteredNodes = nodes.filter((node) => node.id !== id)

    if (filteredNodes.length === nodes.length) {
      return false
    }

    // Also delete any edges connected to this node
    const edges = this.getEdges()
    const filteredEdges = edges.filter((edge) => edge.source !== id && edge.target !== id)

    safeLocalStorage().setItem(this.NODES_STORAGE_KEY, JSON.stringify(filteredNodes))
    safeLocalStorage().setItem(this.EDGES_STORAGE_KEY, JSON.stringify(filteredEdges))
    return true
  }

  // Delete an edge
  public deleteEdge(id: string): boolean {
    const edges = this.getEdges()
    const filteredEdges = edges.filter((edge) => edge.id !== id)

    if (filteredEdges.length === edges.length) {
      return false
    }

    safeLocalStorage().setItem(this.EDGES_STORAGE_KEY, JSON.stringify(filteredEdges))
    return true
  }

  // Delete a workspace
  public deleteWorkspace(id: string): boolean {
    const workspaces = this.getWorkspaces()
    const workspace = workspaces.find((w) => w.id === id)

    if (!workspace) {
      return false
    }

    // Delete the root folder and all its contents
    this.deleteFolder(workspace.rootFolderId)

    const filteredWorkspaces = workspaces.filter((w) => w.id !== id)
    safeLocalStorage().setItem(this.WORKSPACES_STORAGE_KEY, JSON.stringify(filteredWorkspaces))
    return true
  }

  // Delete a folder and all its contents recursively
  public deleteFolder(folderId: string): boolean {
    const nodes = this.getNodes()

    // Find all nodes that have this folder as parent
    const childNodes = nodes.filter((node) => node.parentId === folderId)

    // Recursively delete all child folders
    childNodes.forEach((node) => {
      if (node.type === "folder") {
        this.deleteFolder(node.id)
      } else {
        this.deleteNode(node.id)
      }
    })

    // Delete the folder itself
    return this.deleteNode(folderId)
  }

  // Search for nodes with multi-term relevance scoring
  public searchNodes(query: string, limit = 10): SearchResult[] {
    const nodes = this.getNodes()
    const edges = this.getEdges()

    if (!query.trim()) {
      return []
    }

    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0)

    const scored = nodes
      .map((node) => {
        const titleLower = node.title.toLowerCase()
        const contentLower = node.content.toLowerCase()
        const tagsLower = node.tags.map((t) => t.toLowerCase())

        let score = 0

        // Exact full-query match bonuses
        if (titleLower === queryLower) score += 10
        if (titleLower.includes(queryLower)) score += 5
        if (tagsLower.some((tag) => tag === queryLower)) score += 6

        // Per-term scoring
        for (const term of queryTerms) {
          // Title matches (highest weight)
          if (titleLower.includes(term)) {
            score += 3
            // Bonus if term appears at the start of the title
            if (titleLower.startsWith(term)) score += 1
          }

          // Tag matches (high weight - tags are intentional labels)
          if (tagsLower.some((tag) => tag.includes(term))) score += 2.5

          // Content matches with frequency weighting
          if (contentLower.includes(term)) {
            // Count occurrences (capped to avoid overly long content dominating)
            let count = 0
            let pos = 0
            while ((pos = contentLower.indexOf(term, pos)) !== -1 && count < 5) {
              count++
              pos += term.length
            }
            score += 1 + Math.min(count, 5) * 0.2
          }
        }

        // Term coverage bonus: reward nodes that match more of the query terms
        const matchedTerms = queryTerms.filter(
          (term) =>
            titleLower.includes(term) ||
            contentLower.includes(term) ||
            tagsLower.some((tag) => tag.includes(term)),
        )
        if (queryTerms.length > 1 && matchedTerms.length > 1) {
          score += (matchedTerms.length / queryTerms.length) * 3
        }

        // Recency boost (slight preference for recently updated nodes)
        const daysSinceUpdate = (Date.now() - node.updatedAt.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceUpdate < 7) score += 0.5
        if (daysSinceUpdate < 1) score += 0.5

        return { node, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    // Enrich with related nodes
    return scored.map(({ node, score }) => {
      const connectedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id)
      const relatedNodeIds = connectedEdges.map((edge) => (edge.source === node.id ? edge.target : edge.source))

      const relatedNodes = nodes
        .filter((n) => relatedNodeIds.includes(n.id))
        .map((relatedNode) => {
          const edge = connectedEdges.find(
            (e) =>
              (e.source === node.id && e.target === relatedNode.id) ||
              (e.target === node.id && e.source === relatedNode.id),
          )
          return {
            node: relatedNode,
            similarity: edge?.strength || 0.5,
          }
        })
        .sort((a, b) => b.similarity - a.similarity)

      return { node, score, relatedNodes }
    })
  }

  // Get recommended nodes based on user behavior, connections, and content diversity
  public getRecommendedNodes(limit = 5): KnowledgeNode[] {
    const nodes = this.getNodes()
    const edges = this.getEdges()
    const preferences = this.getUserPreferences()

    if (nodes.length === 0) {
      return []
    }

    const now = Date.now()
    const lastInteraction = preferences.lastInteraction
    const preferredTags: string[] = preferences.preferredTags || []

    // Score each node for recommendation
    const scored = nodes.map((node) => {
      let score = 0

      // 1. Tag affinity: boost nodes matching the user's preferred tags
      if (preferredTags.length > 0) {
        const matchCount = node.tags.filter((tag) => preferredTags.includes(tag)).length
        score += matchCount * 2
      }

      // 2. Recency: prefer recently updated but not *too* recent
      //    (avoid recommending what they just looked at)
      const daysSinceUpdate = (now - node.updatedAt.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceUpdate < 0.1) {
        // Updated in the last ~2.5 hours — they probably already saw it
        score += 0.5
      } else if (daysSinceUpdate < 3) {
        score += 3
      } else if (daysSinceUpdate < 14) {
        score += 1.5
      }

      // 3. Connection richness: nodes with more edges are likely higher value
      const connectionCount = edges.filter(
        (e) => e.source === node.id || e.target === node.id,
      ).length
      score += Math.min(connectionCount, 5) * 0.5

      // 4. Content depth: nodes with substantial content are more useful
      if (node.content.length > 200) score += 1
      if (node.content.length > 500) score += 0.5

      // 5. Related to last interaction: boost neighbors of the most recently viewed node
      if (lastInteraction?.nodeId) {
        const isNeighbor = edges.some(
          (e) =>
            (e.source === lastInteraction.nodeId && e.target === node.id) ||
            (e.target === lastInteraction.nodeId && e.source === node.id),
        )
        if (isNeighbor) score += 3
        // Don't re-recommend the exact node they just interacted with
        if (node.id === lastInteraction.nodeId) score -= 2
      }

      // 6. Type diversity bonus (handled post-scoring via selection)
      return { node, score }
    })

    // Sort by score, then pick with type diversity
    scored.sort((a, b) => b.score - a.score)

    const result: KnowledgeNode[] = []
    const typeCounts: Record<string, number> = {}

    for (const { node } of scored) {
      if (result.length >= limit) break
      // Allow at most 2 of the same type in recommendations for diversity
      const typeCount = typeCounts[node.type] || 0
      if (typeCount >= 2) continue
      result.push(node)
      typeCounts[node.type] = typeCount + 1
    }

    // If we still need more, fill from remaining
    if (result.length < limit) {
      for (const { node } of scored) {
        if (result.length >= limit) break
        if (!result.includes(node)) result.push(node)
      }
    }

    return result
  }

  // Get user preferences
  public getUserPreferences(): Record<string, any> {
    const preferencesJson = safeLocalStorage().getItem(this.USER_PREFERENCES_KEY)
    if (!preferencesJson) {
      return {
        preferredTags: [],
        recentSearches: [],
        theme: "light",
        viewMode: "canvas",
      }
    }

    try {
      return JSON.parse(preferencesJson)
    } catch (error) {
      console.error("Failed to parse user preferences:", error)
      return {
        preferredTags: [],
        recentSearches: [],
        theme: "light",
        viewMode: "canvas",
      }
    }
  }

  // Update user preferences
  public updateUserPreferences(updates: Partial<Record<string, any>>): Record<string, any> {
    const preferences = this.getUserPreferences()
    const updatedPreferences = {
      ...preferences,
      ...updates,
    }

    safeLocalStorage().setItem(this.USER_PREFERENCES_KEY, JSON.stringify(updatedPreferences))
    return updatedPreferences
  }

  // Track user interaction with a node (for personalization)
  public trackNodeInteraction(nodeId: string, interactionType: "view" | "edit" | "create" | "delete"): void {
    const node = this.getNode(nodeId)
    if (!node) return

    const preferences = this.getUserPreferences()

    // Update preferred tags based on interaction
    if (interactionType === "view" || interactionType === "edit") {
      const preferredTags = new Set(preferences.preferredTags || [])

      // Add node tags to preferred tags
      node.tags.forEach((tag) => preferredTags.add(tag))

      // Limit to top 20 tags
      const updatedTags = Array.from(preferredTags).slice(0, 20)

      this.updateUserPreferences({
        preferredTags: updatedTags,
        lastInteraction: {
          nodeId,
          type: interactionType,
          timestamp: new Date().toISOString(),
        },
      })
    }
  }

  // Initialize with demo data if empty
  public initializeWithDemoData(): void {
    const nodes = this.getNodes()
    const workspaces = this.getWorkspaces()

    if (nodes.length === 0 && workspaces.length === 0) {
      // Create a demo workspace
      const workspace = this.createWorkspace("My Knowledge Base", "A demo workspace with sample notes and documents")

      // Create some folders
      const researchFolder = this.createNode("folder", "Research", "", workspace.rootFolderId)
      const projectsFolder = this.createNode("folder", "Projects", "", workspace.rootFolderId)
      const personalFolder = this.createNode("folder", "Personal", "", workspace.rootFolderId)

      // Create some notes
      const note1 = this.createNode(
        "note",
        "Knowledge Graphs Introduction",
        "Knowledge graphs are a powerful way to represent and connect information. They consist of nodes (entities) and edges (relationships).",
        researchFolder.id,
        { x: 100, y: 100 },
        { width: 300, height: 200 },
        ["knowledge-graph", "research"],
      )

      const note2 = this.createNode(
        "note",
        "Project Ideas",
        "1. Build a personal knowledge management system\n2. Create a recommendation engine\n3. Develop a note-taking app with graph visualization",
        projectsFolder.id,
        { x: 500, y: 200 },
        { width: 300, height: 200 },
        ["projects", "ideas"],
      )

      const note3 = this.createNode(
        "note",
        "Learning Goals",
        "- Master TypeScript\n- Learn about vector databases\n- Study graph algorithms\n- Improve UI/UX skills",
        personalFolder.id,
        { x: 300, y: 400 },
        { width: 300, height: 200 },
        ["learning", "goals", "personal"],
      )

      // Create some connections
      this.createEdge(note1.id, note2.id, "inspires", 0.8)
      this.createEdge(note2.id, note3.id, "requires", 0.6)
      this.createEdge(note1.id, note3.id, "related", 0.4)
    }
  }
}

// Export a singleton instance
export const weaviateService = new WeaviateService()

import { safeLocalStorage } from "./browser-utils"
import type { Edge, Node } from "reactflow"

// Flow type definition
export type Flow = {
  id: string
  name: string
  description: string
  nodes: Node[]
  edges: Edge[]
  createdAt: Date
  updatedAt: Date
  version: number
  isPublic: boolean
  isTemplate: boolean
  tags: string[]
  owner: string
  collaborators: string[] // Added collaborators property
}

// Flow service for managing flows
export class FlowService {
  private readonly STORAGE_KEY = "flowiseFlows"

  // Get all flows
  public getFlows(): Flow[] {
    const flowsJson = safeLocalStorage().getItem(this.STORAGE_KEY)
    if (!flowsJson) {
      return []
    }

    try {
      const flows = JSON.parse(flowsJson)
      return flows.map((flow: any) => ({
        ...flow,
        createdAt: new Date(flow.createdAt),
        updatedAt: new Date(flow.updatedAt),
        collaborators: flow.collaborators || [], // Ensure collaborators is always an array
      }))
    } catch (error) {
      console.error("Failed to parse flows:", error)
      return []
    }
  }

  // Get a flow by ID
  public getFlow(id: string): Flow | null {
    const flows = this.getFlows()
    const flow = flows.find((f) => f.id === id)
    return flow || null
  }

  // Create a new flow
  public createFlow(name: string, description: string, nodes: Node[] = [], edges: Edge[] = []): Flow {
    const flows = this.getFlows()
    const now = new Date()

    const newFlow: Flow = {
      id: `flow-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name,
      description,
      nodes,
      edges,
      createdAt: now,
      updatedAt: now,
      version: 1,
      isPublic: false,
      isTemplate: false,
      tags: [],
      owner: "current-user", // In a real app, this would be the current user's ID
      collaborators: [], // Initialize with empty array
    }

    safeLocalStorage().setItem(this.STORAGE_KEY, JSON.stringify([...flows, newFlow]))
    return newFlow
  }

  // Update a flow
  public updateFlow(
    id: string,
    updates: Partial<Omit<Flow, "id" | "createdAt" | "updatedAt" | "version">>,
    incrementVersion = false,
  ): Flow | null {
    const flows = this.getFlows()
    const index = flows.findIndex((f) => f.id === id)

    if (index === -1) {
      return null
    }

    const updatedFlow: Flow = {
      ...flows[index],
      ...updates,
      updatedAt: new Date(),
    }

    if (incrementVersion) {
      updatedFlow.version += 1
    }

    flows[index] = updatedFlow
    safeLocalStorage().setItem(this.STORAGE_KEY, JSON.stringify(flows))
    return updatedFlow
  }

  // Delete a flow
  public deleteFlow(id: string): boolean {
    const flows = this.getFlows()
    const filteredFlows = flows.filter((f) => f.id !== id)

    if (filteredFlows.length === flows.length) {
      return false
    }

    safeLocalStorage().setItem(this.STORAGE_KEY, JSON.stringify(filteredFlows))
    return true
  }

  // Clone a flow
  public cloneFlow(id: string, newName?: string): Flow | null {
    const flow = this.getFlow(id)
    if (!flow) {
      return null
    }

    const now = new Date()
    const clonedFlow: Flow = {
      ...flow,
      id: `flow-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name: newName || `${flow.name} (Copy)`,
      createdAt: now,
      updatedAt: now,
      version: 1,
      isPublic: false,
      collaborators: [], // Reset collaborators for the clone
    }

    const flows = this.getFlows()
    safeLocalStorage().setItem(this.STORAGE_KEY, JSON.stringify([...flows, clonedFlow]))
    return clonedFlow
  }

  // Import a flow from JSON
  public importFlow(flowJson: string): Flow | null {
    try {
      const flow = JSON.parse(flowJson) as Flow
      const now = new Date()

      // Generate a new ID to avoid conflicts
      const importedFlow: Flow = {
        ...flow,
        id: `flow-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        createdAt: now,
        updatedAt: now,
        version: 1,
        collaborators: flow.collaborators || [], // Ensure collaborators is always an array
      }

      const flows = this.getFlows()
      safeLocalStorage().setItem(this.STORAGE_KEY, JSON.stringify([...flows, importedFlow]))
      return importedFlow
    } catch (error) {
      console.error("Failed to import flow:", error)
      return null
    }
  }

  // Get flow templates
  public getTemplates(): Flow[] {
    return this.getFlows().filter((f) => f.isTemplate)
  }

  // Create a flow from a template
  public createFromTemplate(templateId: string, newName?: string): Flow | null {
    return this.cloneFlow(templateId, newName)
  }

  // Add a collaborator to a flow
  public addCollaborator(flowId: string, userId: string): Flow | null {
    const flow = this.getFlow(flowId)
    if (!flow) {
      return null
    }

    // Ensure collaborators is an array
    const collaborators = flow.collaborators || []

    // Check if user is already a collaborator
    if (collaborators.includes(userId)) {
      return flow
    }

    // Add the user to collaborators
    return this.updateFlow(flowId, {
      collaborators: [...collaborators, userId],
    })
  }

  // Remove a collaborator from a flow
  public removeCollaborator(flowId: string, userId: string): Flow | null {
    const flow = this.getFlow(flowId)
    if (!flow) {
      return null
    }

    // Ensure collaborators is an array
    const collaborators = flow.collaborators || []

    // Remove the user from collaborators
    return this.updateFlow(flowId, {
      collaborators: collaborators.filter((id) => id !== userId),
    })
  }

  // Share a flow (make it public)
  public shareFlow(flowId: string, isPublic: boolean): Flow | null {
    return this.updateFlow(flowId, { isPublic })
  }
}

// Export a singleton instance
export const flowService = new FlowService()

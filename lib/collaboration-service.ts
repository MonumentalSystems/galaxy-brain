import { safeLocalStorage, isBrowser } from "./browser-utils"
import type { Edge, Node } from "reactflow"

// Collaboration user type
export type CollaborationUser = {
  id: string
  name: string
  color: string
  cursor?: { x: number; y: number }
  selection?: string[]
  lastActive: Date
}

// Collaboration message type
export type CollaborationMessage = {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: Date
}

// Collaboration event type
export type CollaborationEvent = {
  type: "join" | "leave" | "update" | "chat"
  userId: string
  timestamp: Date
  data?: any
}

// BroadcastChannel message envelope
type BroadcastPayload = {
  flowId: string
  event: CollaborationEvent
}

// Collaboration service for real-time collaboration across tabs
export class CollaborationService {
  private readonly USERS_STORAGE_KEY = "flowiseCollaborationUsers"
  private readonly MESSAGES_STORAGE_KEY = "flowiseCollaborationMessages"
  private readonly CHANNEL_NAME = "flowise-collaboration"
  private currentFlowId: string | null = null
  private currentUserId: string | null = null
  private updateInterval: number | null = null
  private listeners: Set<(event: CollaborationEvent) => void> = new Set()
  private broadcastChannel: BroadcastChannel | null = null

  constructor() {
    this.initBroadcastChannel()
  }

  // Initialize BroadcastChannel for cross-tab communication
  private initBroadcastChannel(): void {
    if (!isBrowser() || typeof BroadcastChannel === "undefined") return

    try {
      this.broadcastChannel = new BroadcastChannel(this.CHANNEL_NAME)
      this.broadcastChannel.onmessage = (event: MessageEvent<BroadcastPayload>) => {
        const { flowId, event: collabEvent } = event.data
        // Only process events for the current flow, and not from ourselves
        if (flowId === this.currentFlowId && collabEvent.userId !== this.currentUserId) {
          // Reconstitute Date
          collabEvent.timestamp = new Date(collabEvent.timestamp)

          // If a remote user joined or left, refresh the user list from storage
          if (collabEvent.type === "join" || collabEvent.type === "leave") {
            // Notify listeners so UI re-renders with updated users
            this.notifyListeners(collabEvent)
          } else {
            this.notifyListeners(collabEvent)
          }
        }
      }
    } catch {
      // BroadcastChannel not available; fall back to localStorage-only
    }
  }

  // Broadcast an event to other tabs
  private broadcast(event: CollaborationEvent): void {
    if (!this.broadcastChannel || !this.currentFlowId) return
    try {
      this.broadcastChannel.postMessage({
        flowId: this.currentFlowId,
        event,
      } satisfies BroadcastPayload)
    } catch {
      // Channel may be closed
    }
  }

  // Subscribe to collaboration events
  public subscribe(listener: (event: CollaborationEvent) => void): () => void {
    this.listeners.add(listener)

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener)
    }
  }

  // Notify all listeners of an event
  private notifyListeners(event: CollaborationEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error("Error in collaboration event listener:", error)
      }
    })
  }

  // Join a flow for collaboration
  public async joinFlow(flowId: string): Promise<string> {
    // Uses localStorage + BroadcastChannel for cross-tab real-time sync
    this.currentFlowId = flowId

    // Generate a random user ID and name
    const userId = `user-${crypto.randomUUID()}`
    this.currentUserId = userId

    // Generate a random color
    const colors = [
      "#FF5733", // Red
      "#33FF57", // Green
      "#3357FF", // Blue
      "#FF33F5", // Pink
      "#F5FF33", // Yellow
      "#33FFF5", // Cyan
      "#FF8333", // Orange
      "#8333FF", // Purple
    ]
    const color = colors[Math.floor(Math.random() * colors.length)]

    // Add user to the collaboration
    const users = this.getUsers(flowId)
    const newUser: CollaborationUser = {
      id: userId,
      name: `User ${users.length + 1}`,
      color,
      lastActive: new Date(),
    }

    safeLocalStorage().setItem(
      this.USERS_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
        [flowId]: [...users, newUser],
      }),
    )

    // Start sending updates
    this.startSendingUpdates()

    // Notify local listeners and broadcast to other tabs
    const joinEvent: CollaborationEvent = {
      type: "join",
      userId,
      timestamp: new Date(),
      data: { user: newUser },
    }
    this.notifyListeners(joinEvent)
    this.broadcast(joinEvent)

    return userId
  }

  // Leave the current flow
  public leaveFlow(): void {
    if (!this.currentFlowId || !this.currentUserId) return

    // Remove user from the collaboration
    const users = this.getUsers(this.currentFlowId)
    const updatedUsers = users.filter((u) => u.id !== this.currentUserId)

    safeLocalStorage().setItem(
      this.USERS_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
        [this.currentFlowId]: updatedUsers,
      }),
    )

    // Notify local listeners and broadcast to other tabs
    const leaveEvent: CollaborationEvent = {
      type: "leave",
      userId: this.currentUserId,
      timestamp: new Date(),
    }
    this.notifyListeners(leaveEvent)
    this.broadcast(leaveEvent)

    // Stop sending updates
    this.stopSendingUpdates()

    this.currentFlowId = null
    this.currentUserId = null
  }

  // Update flow data and broadcast to other tabs
  public updateFlow(nodes: Node[], edges: Edge[]): void {
    this.updateUserActivity()

    if (!this.currentUserId || !this.currentFlowId) return

    // Store the latest flow state so other tabs can pick it up
    safeLocalStorage().setItem(
      `flowiseCollabFlowState_${this.currentFlowId}`,
      JSON.stringify({ nodes, edges, updatedBy: this.currentUserId, updatedAt: new Date().toISOString() }),
    )

    // Notify local listeners and broadcast to other tabs
    const updateEvent: CollaborationEvent = {
      type: "update",
      userId: this.currentUserId,
      timestamp: new Date(),
      data: { nodes, edges },
    }
    this.notifyListeners(updateEvent)
    this.broadcast(updateEvent)
  }

  // Get the latest shared flow state (from any tab)
  public getSharedFlowState(flowId: string): { nodes: Node[]; edges: Edge[]; updatedBy: string; updatedAt: string } | null {
    const data = safeLocalStorage().getItem(`flowiseCollabFlowState_${flowId}`)
    if (!data) return null
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  // Update cursor position
  public updateCursor(x: number, y: number): void {
    if (!this.currentFlowId || !this.currentUserId) return

    const users = this.getUsers(this.currentFlowId)
    const userIndex = users.findIndex((u) => u.id === this.currentUserId)

    if (userIndex === -1) return

    users[userIndex].cursor = { x, y }
    users[userIndex].lastActive = new Date()

    safeLocalStorage().setItem(
      this.USERS_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
        [this.currentFlowId]: users,
      }),
    )
  }

  // Update selection
  public updateSelection(selection: string[]): void {
    if (!this.currentFlowId || !this.currentUserId) return

    const users = this.getUsers(this.currentFlowId)
    const userIndex = users.findIndex((u) => u.id === this.currentUserId)

    if (userIndex === -1) return

    users[userIndex].selection = selection
    users[userIndex].lastActive = new Date()

    safeLocalStorage().setItem(
      this.USERS_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
        [this.currentFlowId]: users,
      }),
    )
  }

  // Send a chat message
  public sendChatMessage(content: string): void {
    if (!this.currentFlowId || !this.currentUserId) return

    const users = this.getUsers(this.currentFlowId)
    const user = users.find((u) => u.id === this.currentUserId)

    if (!user) return

    const messages = this.getMessages(this.currentFlowId)
    const newMessage: CollaborationMessage = {
      id: `message-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      userId: this.currentUserId,
      userName: user.name,
      content,
      timestamp: new Date(),
    }

    safeLocalStorage().setItem(
      this.MESSAGES_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.MESSAGES_STORAGE_KEY) || "{}"),
        [this.currentFlowId]: [...messages, newMessage],
      }),
    )

    this.updateUserActivity()

    // Notify local listeners and broadcast to other tabs
    const chatEvent: CollaborationEvent = {
      type: "chat",
      userId: this.currentUserId,
      timestamp: new Date(),
      data: { message: content },
    }
    this.notifyListeners(chatEvent)
    this.broadcast(chatEvent)
  }

  // Get all users in a flow
  public getUsers(flowId: string): CollaborationUser[] {
    const usersData = JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}")
    const users = usersData[flowId] || []

    return users.map((user: any) => ({
      ...user,
      lastActive: new Date(user.lastActive),
    }))
  }

  // Get all messages in a flow
  public getMessages(flowId: string): CollaborationMessage[] {
    const messagesData = JSON.parse(safeLocalStorage().getItem(this.MESSAGES_STORAGE_KEY) || "{}")
    const messages = messagesData[flowId] || []

    return messages.map((message: any) => ({
      ...message,
      timestamp: new Date(message.timestamp),
    }))
  }

  // Get the current user
  public getCurrentUser(): CollaborationUser | null {
    if (!this.currentFlowId || !this.currentUserId) return null

    const users = this.getUsers(this.currentFlowId)
    return users.find((u) => u.id === this.currentUserId) || null
  }

  // Update user activity
  private updateUserActivity(): void {
    if (!this.currentFlowId || !this.currentUserId) return

    const users = this.getUsers(this.currentFlowId)
    const userIndex = users.findIndex((u) => u.id === this.currentUserId)

    if (userIndex === -1) return

    users[userIndex].lastActive = new Date()

    safeLocalStorage().setItem(
      this.USERS_STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
        [this.currentFlowId]: users,
      }),
    )
  }

  // Remove stale users (inactive for more than 30 seconds)
  private cleanupStaleUsers(): void {
    if (!this.currentFlowId) return

    const users = this.getUsers(this.currentFlowId)
    const now = Date.now()
    const staleThreshold = 30000 // 30 seconds

    const activeUsers = users.filter((u) => {
      if (u.id === this.currentUserId) return true
      return now - u.lastActive.getTime() < staleThreshold
    })

    if (activeUsers.length < users.length) {
      safeLocalStorage().setItem(
        this.USERS_STORAGE_KEY,
        JSON.stringify({
          ...JSON.parse(safeLocalStorage().getItem(this.USERS_STORAGE_KEY) || "{}"),
          [this.currentFlowId]: activeUsers,
        }),
      )
    }
  }

  // Start sending periodic updates and cleaning up stale users
  private startSendingUpdates(): void {
    this.updateInterval = window.setInterval(() => {
      this.updateUserActivity()
      this.cleanupStaleUsers()
    }, 5000) as unknown as number
  }

  // Stop sending periodic updates
  private stopSendingUpdates(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
  }

  // Clean up resources
  public destroy(): void {
    this.leaveFlow()
    if (this.broadcastChannel) {
      this.broadcastChannel.close()
      this.broadcastChannel = null
    }
  }
}

// Export a singleton instance
export const collaborationService = new CollaborationService()

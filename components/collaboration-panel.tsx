"use client"

import { useEffect, useState } from "react"
import { Send, User, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { collaborationService, type CollaborationEvent } from "@/lib/collaboration-service"

type ChatMessage = {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: Date
}

type CollaborationPanelProps = {
  flowId: string
}

export function CollaborationPanel({ flowId }: CollaborationPanelProps) {
  const [collaborators, setCollaborators] = useState<any[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")

  // Subscribe to collaboration events
  useEffect(() => {
    // Initial load
    setCollaborators(collaborationService.getUsers(flowId))

    // Subscribe to events
    const unsubscribe = collaborationService.subscribe((event: CollaborationEvent) => {
      if (event.type === "join" || event.type === "leave") {
        setCollaborators(collaborationService.getUsers(flowId))
      } else if (event.type === "chat") {
        const newMessage: ChatMessage = {
          id: `msg-${crypto.randomUUID()}`,
          userId: event.userId,
          userName: collaborationService.getUsers(flowId).find((c) => c.id === event.userId)?.name || "Unknown",
          content: event.data?.message || "",
          timestamp: event.timestamp,
        }
        setMessages((prev) => [...prev, newMessage])
      }
    })

    return unsubscribe
  }, [flowId])

  // Send a chat message
  const sendMessage = () => {
    if (!input.trim()) return
    collaborationService.sendChatMessage(input)
    setInput("")
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <h3 className="font-medium flex items-center">
          <Users className="mr-2 h-4 w-4" />
          Collaborators ({collaborators.length})
        </h3>
        <div className="mt-2 space-y-2">
          {collaborators.map((collaborator) => (
            <div key={collaborator.id} className="flex items-center">
              <div className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: collaborator.color }} />
              <span className="text-sm">{collaborator.name}</span>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex-1 flex flex-col">
        <ScrollArea className="flex-1 p-4">
          <div className="space-y-4">
            {messages.map((message) => (
              <div key={message.id} className="flex items-start gap-2">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white"
                  style={{ backgroundColor: collaborators.find((c) => c.id === message.userId)?.color || "#888" }}
                >
                  <User className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{message.userName}</span>
                    <span className="text-xs text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
                  </div>
                  <p className="text-sm">{message.content}</p>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="border-t p-4">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  sendMessage()
                }
              }}
            />
            <Button size="icon" onClick={sendMessage}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

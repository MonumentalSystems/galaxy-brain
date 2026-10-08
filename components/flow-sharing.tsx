"use client"

import { useState } from "react"
import { Copy, Share2, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/use-toast"
import { flowService, type Flow } from "@/lib/flow-service"
import { safeLocalStorage } from "@/lib/browser-utils"

const COLLABORATOR_MAP_KEY = "flowiseCollaboratorEmails"

// Store and retrieve email-to-userId mapping
function getCollaboratorMap(): Record<string, string> {
  try {
    return JSON.parse(safeLocalStorage().getItem(COLLABORATOR_MAP_KEY) || "{}")
  } catch {
    return {}
  }
}

function saveCollaboratorEmail(userId: string, email: string): void {
  const map = getCollaboratorMap()
  map[userId] = email
  safeLocalStorage().setItem(COLLABORATOR_MAP_KEY, JSON.stringify(map))
}

function getCollaboratorEmail(userId: string): string | null {
  return getCollaboratorMap()[userId] || null
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

type FlowSharingProps = {
  flow: Flow
  onFlowUpdated: (flow: Flow) => void
}

export function FlowSharing({ flow, onFlowUpdated }: FlowSharingProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPublic, setIsPublic] = useState(flow.isPublic)
  const [collaboratorEmail, setCollaboratorEmail] = useState("")
  // Ensure collaborators is always an array
  const [collaborators, setCollaborators] = useState<string[]>(flow.collaborators || [])

  // Toggle public access
  const togglePublicAccess = () => {
    const updatedFlow = flowService.shareFlow(flow.id, !isPublic)
    if (updatedFlow) {
      setIsPublic(updatedFlow.isPublic)
      onFlowUpdated(updatedFlow)
    }
  }

  // Add collaborator
  const addCollaborator = () => {
    const email = collaboratorEmail.trim()

    if (!email) {
      toast({
        title: "Missing email",
        description: "Please enter a collaborator email",
        variant: "destructive",
      })
      return
    }

    if (!isValidEmail(email)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address",
        variant: "destructive",
      })
      return
    }

    // Check if this email is already a collaborator
    const existingMap = getCollaboratorMap()
    const existingUserId = Object.entries(existingMap).find(
      ([uid, e]) => e === email && (collaborators || []).includes(uid),
    )?.[0]

    if (existingUserId) {
      toast({
        title: "Already a collaborator",
        description: `${email} is already a collaborator on this flow`,
        variant: "destructive",
      })
      return
    }

    const userId = `user-${crypto.randomUUID()}`
    saveCollaboratorEmail(userId, email)

    const updatedFlow = flowService.addCollaborator(flow.id, userId)

    if (updatedFlow) {
      setCollaborators(updatedFlow.collaborators || [])
      setCollaboratorEmail("")
      onFlowUpdated(updatedFlow)
      toast({
        title: "Collaborator added",
        description: `${email} has been added as a collaborator`,
      })
    }
  }

  // Remove collaborator
  const removeCollaborator = (userId: string) => {
    const updatedFlow = flowService.removeCollaborator(flow.id, userId)
    if (updatedFlow) {
      setCollaborators(updatedFlow.collaborators || [])
      onFlowUpdated(updatedFlow)
    }
  }

  // Copy sharing link
  const copyLink = () => {
    const link = `${window.location.origin}?flow=${flow.id}`
    navigator.clipboard.writeText(link)
    toast({
      title: "Link copied",
      description: "The sharing link has been copied to your clipboard",
    })
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Share2 className="mr-2 h-4 w-4" />
            Share
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Share Flow</DialogTitle>
            <DialogDescription>Share your flow with others or make it public</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="public-access" className="block">
                  Public Access
                </Label>
                <p className="text-xs text-muted-foreground">Anyone with the link can view this flow</p>
              </div>
              <Switch id="public-access" checked={isPublic} onCheckedChange={togglePublicAccess} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sharing-link">Sharing Link</Label>
              <div className="flex items-center gap-2">
                <Input id="sharing-link" value={`${window.location.origin}?flow=${flow.id}`} readOnly />
                <Button variant="outline" size="icon" onClick={copyLink}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="collaborator-email">Add Collaborator</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="collaborator-email"
                  value={collaboratorEmail}
                  onChange={(e) => setCollaboratorEmail(e.target.value)}
                  placeholder="Enter email address"
                />
                <Button onClick={addCollaborator}>Add</Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Collaborators</Label>
              {collaborators.length === 0 ? (
                <p className="text-sm text-muted-foreground">No collaborators yet</p>
              ) : (
                <div className="space-y-2">
                  {collaborators.map((userId) => (
                    <div key={userId} className="flex items-center justify-between rounded-md border p-2">
                      <div className="flex items-center">
                        <Users className="h-4 w-4 mr-2" />
                        <span className="text-sm">
                          {getCollaboratorEmail(userId) || `Collaborator (${userId.substring(0, 8)})`}
                        </span>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => removeCollaborator(userId)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

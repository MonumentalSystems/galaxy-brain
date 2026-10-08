"use client"

import { useState } from "react"
import { Key } from "lucide-react"

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
import { toast } from "@/components/ui/use-toast"
import { safeLocalStorage } from "@/lib/browser-utils"

type ApiKey = {
  id: string
  name: string
  key: string
  service: string
  createdAt: Date
}

// Local storage key for API keys
const API_KEYS_STORAGE_KEY = "flowiseApiKeys"

export function ApiKeyManager() {
  const [isOpen, setIsOpen] = useState(false)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(() => {
    const keysJson = safeLocalStorage().getItem(API_KEYS_STORAGE_KEY)
    if (!keysJson) return []
    try {
      const keys = JSON.parse(keysJson)
      return keys.map((key: any) => ({
        ...key,
        createdAt: new Date(key.createdAt),
      }))
    } catch (error) {
      return []
    }
  })
  const [newKeyName, setNewKeyName] = useState("")
  const [newKeyValue, setNewKeyValue] = useState("")
  const [newKeyService, setNewKeyService] = useState("")

  // Add a new API key
  const addApiKey = () => {
    if (!newKeyName || !newKeyValue || !newKeyService) {
      toast({
        title: "Missing information",
        description: "Please fill in all fields",
        variant: "destructive",
      })
      return
    }

    const newKey: ApiKey = {
      id: `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name: newKeyName,
      key: newKeyValue,
      service: newKeyService,
      createdAt: new Date(),
    }

    const updatedKeys = [...apiKeys, newKey]
    setApiKeys(updatedKeys)
    safeLocalStorage().setItem(API_KEYS_STORAGE_KEY, JSON.stringify(updatedKeys))

    setNewKeyName("")
    setNewKeyValue("")
    setNewKeyService("")

    toast({
      title: "API key added",
      description: `${newKeyName} has been added successfully`,
    })
  }

  // Delete an API key
  const deleteApiKey = (id: string) => {
    const updatedKeys = apiKeys.filter((key) => key.id !== id)
    setApiKeys(updatedKeys)
    safeLocalStorage().setItem(API_KEYS_STORAGE_KEY, JSON.stringify(updatedKeys))

    toast({
      title: "API key deleted",
      description: "The API key has been deleted",
    })
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Key className="mr-2 h-4 w-4" />
            API Keys
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Manage API Keys</DialogTitle>
            <DialogDescription>Add or remove API keys for various services</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="OpenAI API Key"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="key-service">Service</Label>
              <Input
                id="key-service"
                value={newKeyService}
                onChange={(e) => setNewKeyService(e.target.value)}
                placeholder="openai"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="key-value">API Key</Label>
              <Input
                id="key-value"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                type="password"
                placeholder="sk-..."
              />
            </div>
            <Button onClick={addApiKey}>Add API Key</Button>
          </div>

          <div className="space-y-4">
            <h4 className="text-sm font-medium">Your API Keys</h4>
            {apiKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">No API keys added yet</p>
            ) : (
              <div className="space-y-2">
                {apiKeys.map((key) => (
                  <div key={key.id} className="flex items-center justify-between rounded-md border p-2">
                    <div>
                      <p className="text-sm font-medium">{key.name}</p>
                      <p className="text-xs text-muted-foreground">{key.service}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => deleteApiKey(key.id)}>
                      Delete
                    </Button>
                  </div>
                ))}
              </div>
            )}
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

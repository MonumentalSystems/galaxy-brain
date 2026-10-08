"use client"

import type React from "react"

import { useState } from "react"
import { Upload } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import { flowService, type Flow } from "@/lib/flow-service"

type FlowImportProps = {
  onFlowImported: (flow: Flow) => void
}

export function FlowImport({ onFlowImported }: FlowImportProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [importMethod, setImportMethod] = useState<"file" | "json">("file")
  const [jsonContent, setJsonContent] = useState("")
  const [file, setFile] = useState<File | null>(null)

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0])
    }
  }

  // Import flow
  const importFlow = async () => {
    try {
      let flowJson = ""

      if (importMethod === "file" && file) {
        // Read file content
        const text = await file.text()
        flowJson = text
      } else if (importMethod === "json" && jsonContent) {
        flowJson = jsonContent
      } else {
        toast({
          title: "Missing data",
          description: "Please provide a file or JSON content",
          variant: "destructive",
        })
        return
      }

      // Import flow
      const importedFlow = flowService.importFlow(flowJson)

      if (importedFlow) {
        onFlowImported(importedFlow)
        setIsOpen(false)
        toast({
          title: "Flow imported",
          description: `"${importedFlow.name}" has been imported successfully`,
        })
      } else {
        toast({
          title: "Import failed",
          description: "Failed to import flow. Please check the file format.",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      })
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Import Flow</DialogTitle>
            <DialogDescription>Import a flow from a file or paste JSON content</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex items-center space-x-4">
              <Button
                variant={importMethod === "file" ? "default" : "outline"}
                onClick={() => setImportMethod("file")}
                className="flex-1"
              >
                From File
              </Button>
              <Button
                variant={importMethod === "json" ? "default" : "outline"}
                onClick={() => setImportMethod("json")}
                className="flex-1"
              >
                Paste JSON
              </Button>
            </div>

            {importMethod === "file" ? (
              <div className="space-y-2">
                <Label htmlFor="flow-file">Flow File</Label>
                <Input id="flow-file" type="file" accept=".json" onChange={handleFileSelect} />
                {file && <p className="text-xs text-muted-foreground">Selected file: {file.name}</p>}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="flow-json">Flow JSON</Label>
                <Textarea
                  id="flow-json"
                  value={jsonContent}
                  onChange={(e) => setJsonContent(e.target.value)}
                  placeholder="Paste flow JSON here"
                  rows={10}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={importFlow}>Import Flow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

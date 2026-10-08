"use client"

import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FlowEditor } from "@/components/flow-editor"

interface Props {
  onClose: () => void
}

export function WorkflowPanel({ onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="AI Workflow Editor" className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-6xl h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <h2 className="font-semibold">AI Workflow Editor</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <FlowEditor />
        </div>
      </div>
    </div>
  )
}

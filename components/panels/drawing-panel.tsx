"use client"

import { Button } from "@/components/ui/button"
import { DrawingEditor } from "@/components/drawing-editor"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"
import { contentProcessingService } from "@/lib/content-processing-service"

interface Props {
  node: GalaxyNode
  showGrid: boolean
  onClose: () => void
}

export function DrawingPanel({ node, showGrid, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="Drawing canvas" className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-6xl h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${showGrid ? "bg-cyan-500" : "bg-rose-500"}`} />
            <h2 className="font-semibold">{node.title || (showGrid ? "Whiteboard" : "Drawing")}</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <span className="sr-only">Close</span>✕
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <DrawingEditor
            canvasId={node.id}
            initialState={node.content || null}
            showGrid={showGrid}
            onSave={(stateJson) => {
              galaxyBrainService.updateNode(node.id, { content: stateJson })
              contentProcessingService.enqueueNode(node.id)
              onClose()
            }}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  )
}

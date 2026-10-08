"use client"

import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MediaViewer, type MediaType } from "@/components/media-viewer"
import { type GalaxyNode } from "@/lib/galaxy-brain-service"

interface Props {
  node: GalaxyNode | null
  src: string
  mediaType: MediaType
  onClose: () => void
}

export function MediaViewerPanel({ node, src, mediaType, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="Media viewer" className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-4xl h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-pink-500" />
            <h2 className="font-semibold">{node?.title || "Media Viewer"}</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <MediaViewer src={src} mediaType={mediaType} title={node?.title} className="h-full" />
        </div>
      </div>
    </div>
  )
}

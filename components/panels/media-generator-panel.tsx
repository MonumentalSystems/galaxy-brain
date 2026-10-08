"use client"

import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MediaGenerator, type GenerationType, type GenerationResult } from "@/components/media-generator"

interface Props {
  defaultType: GenerationType
  onGenerated: (result: GenerationResult) => void
  onClose: () => void
}

export function MediaGeneratorPanel({ defaultType, onGenerated, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="AI Media Generator" className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <h2 className="font-semibold">AI Media Generator</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <MediaGenerator defaultType={defaultType} onGenerated={onGenerated} className="h-full" />
        </div>
      </div>
    </div>
  )
}

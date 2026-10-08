"use client"

import { Handle, Position } from "reactflow"

import { ImageIcon } from "lucide-react"

export function MediaProcessorNode({ data }: { data: { label: string } }) {
  return (
    <div className="bg-white border rounded-md shadow-sm p-3 min-w-[150px]">
      <div className="flex items-center gap-2">
        <ImageIcon className="h-5 w-5 text-primary" />
        <div className="font-medium">{data.label}</div>
      </div>
      <div className="text-xs text-muted-foreground mt-1">Process media files</div>
      <Handle type="target" position={Position.Left} className="w-3 h-3" />
      <Handle type="source" position={Position.Right} className="w-3 h-3" />
    </div>
  )
}

"use client"

import { Handle, Position } from "reactflow"

import { Layers } from "lucide-react"

export function OutputNode({ data }: { data: { label: string } }) {
  return (
    <div className="bg-white border rounded-md shadow-sm p-3 min-w-[150px]">
      <div className="flex items-center gap-2">
        <Layers className="h-5 w-5 text-primary" />
        <div className="font-medium">{data.label}</div>
      </div>
      <div className="text-xs text-muted-foreground mt-1">Display output</div>
      <Handle type="target" position={Position.Left} className="w-3 h-3" />
    </div>
  )
}

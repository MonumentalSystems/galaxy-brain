"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/use-toast"
import { safeLocalStorage } from "@/lib/browser-utils"

export function DocumentProcessingConfig() {
  const [chunkSize, setChunkSize] = useState(1000)
  const [chunkOverlap, setChunkOverlap] = useState(200)
  const [includeMetadata, setIncludeMetadata] = useState(true)
  const [extractImages, setExtractImages] = useState(false)
  const [extractTables, setExtractTables] = useState(false)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Chunk Size</Label>
        <div className="flex items-center gap-4">
          <Slider
            value={[chunkSize]}
            min={100}
            max={2000}
            step={100}
            onValueChange={(value) => setChunkSize(value[0])}
            className="flex-1"
          />
          <Input
            type="number"
            value={chunkSize}
            onChange={(e) => setChunkSize(Number(e.target.value))}
            className="w-20"
          />
        </div>
        <p className="text-xs text-muted-foreground">Number of characters per chunk</p>
      </div>

      <div className="space-y-2">
        <Label>Chunk Overlap</Label>
        <div className="flex items-center gap-4">
          <Slider
            value={[chunkOverlap]}
            min={0}
            max={500}
            step={50}
            onValueChange={(value) => setChunkOverlap(value[0])}
            className="flex-1"
          />
          <Input
            type="number"
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(Number(e.target.value))}
            className="w-20"
          />
        </div>
        <p className="text-xs text-muted-foreground">Number of characters to overlap between chunks</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="include-metadata">Include Metadata</Label>
          <Switch id="include-metadata" checked={includeMetadata} onCheckedChange={setIncludeMetadata} />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="extract-images">Extract Images</Label>
          <Switch id="extract-images" checked={extractImages} onCheckedChange={setExtractImages} />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="extract-tables">Extract Tables</Label>
          <Switch id="extract-tables" checked={extractTables} onCheckedChange={setExtractTables} />
        </div>
      </div>

      <Button className="w-full" onClick={() => {
        safeLocalStorage().setItem("galaxyDocProcessing", JSON.stringify({ chunkSize, chunkOverlap, includeMetadata, extractImages, extractTables }))
        toast({ title: "Configuration saved", description: `Chunk size: ${chunkSize}, overlap: ${chunkOverlap}` })
      }}>Save Configuration</Button>
    </div>
  )
}

"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/use-toast"
import { safeLocalStorage } from "@/lib/browser-utils"

export function MediaProcessingConfig() {
  const [processingType, setProcessingType] = useState("image")
  const [imageQuality, setImageQuality] = useState(80)
  const [videoResolution, setVideoResolution] = useState("720p")
  const [enableFaceDetection, setEnableFaceDetection] = useState(false)
  const [enableObjectDetection, setEnableObjectDetection] = useState(false)
  const [apiKey, setApiKey] = useState("")

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="processing-type">Processing Type</Label>
        <Select value={processingType} onValueChange={setProcessingType}>
          <SelectTrigger id="processing-type">
            <SelectValue placeholder="Select processing type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">Image Processing</SelectItem>
            <SelectItem value="video">Video Processing</SelectItem>
            <SelectItem value="audio">Audio Processing</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {processingType === "image" && (
        <>
          <div className="space-y-2">
            <Label>Image Quality</Label>
            <div className="flex items-center gap-4">
              <Slider
                value={[imageQuality]}
                min={10}
                max={100}
                step={10}
                onValueChange={(value) => setImageQuality(value[0])}
                className="flex-1"
              />
              <span className="w-12 text-center">{imageQuality}%</span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="face-detection">Face Detection</Label>
              <Switch id="face-detection" checked={enableFaceDetection} onCheckedChange={setEnableFaceDetection} />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="object-detection">Object Detection</Label>
              <Switch
                id="object-detection"
                checked={enableObjectDetection}
                onCheckedChange={setEnableObjectDetection}
              />
            </div>
          </div>
        </>
      )}

      {processingType === "video" && (
        <div className="space-y-2">
          <Label htmlFor="video-resolution">Video Resolution</Label>
          <Select value={videoResolution} onValueChange={setVideoResolution}>
            <SelectTrigger id="video-resolution">
              <SelectValue placeholder="Select video resolution" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="480p">480p</SelectItem>
              <SelectItem value="720p">720p (HD)</SelectItem>
              <SelectItem value="1080p">1080p (Full HD)</SelectItem>
              <SelectItem value="4k">4K (Ultra HD)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="api-key">API Key (if needed)</Label>
        <Input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter API key"
        />
      </div>

      <Button className="w-full" onClick={() => {
        safeLocalStorage().setItem("galaxyMediaProcessing", JSON.stringify({ processingType, imageQuality, videoResolution, enableFaceDetection, enableObjectDetection, apiKey }))
        toast({ title: "Configuration saved", description: `${processingType} processing configured` })
      }}>Save Configuration</Button>
    </div>
  )
}

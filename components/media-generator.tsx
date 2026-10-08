"use client"

import { useState } from "react"
import { Box, Film, ImageIcon, Loader2, Sparkles, Wand2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import { safeLocalStorage } from "@/lib/browser-utils"

export type GenerationType = "image" | "video" | "3d"

type ModelConfig = {
  id: string
  name: string
  type: GenerationType
  endpoint: string
  apiKey: string
  model?: string
}

const MODELS_STORAGE_KEY = "galaxyMediaGenModels"

function isDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function getStoredModels(): ModelConfig[] {
  try {
    return JSON.parse(safeLocalStorage().getItem(MODELS_STORAGE_KEY) || "[]")
  } catch {
    return []
  }
}

function saveModels(models: ModelConfig[]): void {
  safeLocalStorage().setItem(MODELS_STORAGE_KEY, JSON.stringify(models))
}

// Preset model templates
const MODEL_PRESETS: Omit<ModelConfig, "id" | "apiKey">[] = [
  { name: "OpenAI DALL-E 3", type: "image", endpoint: "https://api.openai.com/v1/images/generations", model: "dall-e-3" },
  { name: "OpenAI DALL-E 2", type: "image", endpoint: "https://api.openai.com/v1/images/generations", model: "dall-e-2" },
  { name: "Stability AI (SDXL)", type: "image", endpoint: "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image" },
  { name: "Replicate (SD)", type: "image", endpoint: "https://api.replicate.com/v1/predictions" },
  { name: "Replicate (Video)", type: "video", endpoint: "https://api.replicate.com/v1/predictions" },
  { name: "Meshy (3D)", type: "3d", endpoint: "https://api.meshy.ai/v1/text-to-3d" },
  { name: "Custom Endpoint", type: "image", endpoint: "" },
]

type MediaGeneratorProps = {
  defaultType?: GenerationType
  onGenerated?: (result: GenerationResult) => void
  className?: string
}

export type GenerationResult = {
  type: GenerationType
  prompt: string
  url: string
  modelName: string
  timestamp: Date
}

export function MediaGenerator({ defaultType = "image", onGenerated, className = "" }: MediaGeneratorProps) {
  const [genType, setGenType] = useState<GenerationType>(defaultType)
  const [prompt, setPrompt] = useState("")
  const [negativePrompt, setNegativePrompt] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Model configuration
  const [models, setModels] = useState<ModelConfig[]>(getStoredModels)
  const [showModelConfig, setShowModelConfig] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState<string>("")

  // Generation params
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [steps, setSteps] = useState(30)
  const [cfgScale, setCfgScale] = useState(7)

  // New model form
  const [newModelPreset, setNewModelPreset] = useState("")
  const [newModelName, setNewModelName] = useState("")
  const [newModelEndpoint, setNewModelEndpoint] = useState("")
  const [newModelApiKey, setNewModelApiKey] = useState("")
  const [newModelType, setNewModelType] = useState<GenerationType>("image")

  const filteredModels = models.filter((m) => m.type === genType)
  const selectedModel = models.find((m) => m.id === selectedModelId)

  const addModel = () => {
    if (!newModelName.trim() || !newModelEndpoint.trim()) {
      toast({ title: "Missing fields", description: "Name and endpoint are required", variant: "destructive" })
      return
    }

    const model: ModelConfig = {
      id: `model-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      name: newModelName.trim(),
      type: newModelType,
      endpoint: newModelEndpoint.trim(),
      apiKey: newModelApiKey,
      model: undefined,
    }

    const updated = [...models, model]
    setModels(updated)
    saveModels(updated)
    setSelectedModelId(model.id)
    setNewModelName("")
    setNewModelEndpoint("")
    setNewModelApiKey("")
    setShowModelConfig(false)
    toast({ title: "Model added", description: `${model.name} has been configured` })
  }

  const removeModel = (id: string) => {
    const updated = models.filter((m) => m.id !== id)
    setModels(updated)
    saveModels(updated)
    if (selectedModelId === id) setSelectedModelId("")
  }

  const applyPreset = (presetIdx: string) => {
    const preset = MODEL_PRESETS[parseInt(presetIdx)]
    if (!preset) return
    setNewModelName(preset.name)
    setNewModelEndpoint(preset.endpoint)
    setNewModelType(preset.type)
    setNewModelPreset(presetIdx)
  }

  const generate = async () => {
    if (!prompt.trim()) {
      toast({ title: "Missing prompt", description: "Enter a prompt to generate media", variant: "destructive" })
      return
    }

    if (!selectedModel) {
      toast({ title: "No model selected", description: "Configure and select a model first", variant: "destructive" })
      return
    }

    setIsGenerating(true)
    setResult(null)

    try {
      const endpoint = new URL(selectedModel.endpoint)
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
        throw new Error("Generation endpoint must use HTTP or HTTPS.")
      }
      const hostname = endpoint.hostname.toLowerCase()

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      if (selectedModel.apiKey) {
        headers["Authorization"] = `Bearer ${selectedModel.apiKey}`
      }

      // Build request body based on known endpoint patterns
      let body: Record<string, any>

      if (isDomain(hostname, "openai.com")) {
        body = {
          model: selectedModel.model || "dall-e-3",
          prompt: prompt.trim(),
          n: 1,
          size: `${width}x${height}`,
        }
      } else if (isDomain(hostname, "stability.ai")) {
        body = {
          text_prompts: [
            { text: prompt.trim(), weight: 1 },
            ...(negativePrompt.trim() ? [{ text: negativePrompt.trim(), weight: -1 }] : []),
          ],
          cfg_scale: cfgScale,
          steps,
          width,
          height,
        }
      } else if (isDomain(hostname, "replicate.com")) {
        body = {
          input: {
            prompt: prompt.trim(),
            negative_prompt: negativePrompt.trim() || undefined,
            width,
            height,
            num_inference_steps: steps,
            guidance_scale: cfgScale,
          },
        }
      } else if (isDomain(hostname, "meshy.ai")) {
        body = {
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim() || undefined,
          mode: "preview",
        }
      } else {
        // Generic request body
        body = {
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim() || undefined,
          width,
          height,
          steps,
          cfg_scale: cfgScale,
        }
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`API error ${response.status}: ${errText.substring(0, 200)}`)
      }

      const data = await response.json()

      // Extract the result URL from various API response formats
      let resultUrl: string | null = null

      if (data.data?.[0]?.url) resultUrl = data.data[0].url // OpenAI
      else if (data.data?.[0]?.b64_json) resultUrl = `data:image/png;base64,${data.data[0].b64_json}`
      else if (data.artifacts?.[0]?.base64) resultUrl = `data:image/png;base64,${data.artifacts[0].base64}` // Stability
      else if (data.output?.[0]) resultUrl = data.output[0] // Replicate
      else if (data.output) resultUrl = typeof data.output === "string" ? data.output : null
      else if (data.result?.model_url) resultUrl = data.result.model_url // Meshy
      else if (data.url) resultUrl = data.url
      else if (data.image) resultUrl = data.image

      if (!resultUrl) {
        throw new Error("Could not extract result from API response. Check your endpoint configuration.")
      }

      setResult(resultUrl)
      onGenerated?.({
        type: genType,
        prompt: prompt.trim(),
        url: resultUrl,
        modelName: selectedModel.name,
        timestamp: new Date(),
      })

      toast({ title: "Generation complete", description: `${genType} has been generated successfully` })
    } catch (err: any) {
      toast({
        title: "Generation failed",
        description: err.message || "Unknown error occurred",
        variant: "destructive",
      })
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Type selector */}
      <div className="flex items-center gap-2 p-4 border-b">
        {(["image", "video", "3d"] as GenerationType[]).map((t) => (
          <Button
            key={t}
            variant={genType === t ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => { setGenType(t); setResult(null) }}
          >
            {t === "image" ? <ImageIcon className="h-4 w-4" /> : t === "video" ? <Film className="h-4 w-4" /> : <Box className="h-4 w-4" />}
            {t === "3d" ? "3D Model" : t.charAt(0).toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Model selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Model</Label>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowModelConfig(!showModelConfig)}>
              {showModelConfig ? "Cancel" : "+ Add Model"}
            </Button>
          </div>

          {showModelConfig ? (
            <div className="border rounded-md p-3 space-y-3 bg-muted/30">
              <div className="space-y-2">
                <Label className="text-xs">Start from preset</Label>
                <Select value={newModelPreset} onValueChange={applyPreset}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose a preset..." />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_PRESETS.map((p, i) => (
                      <SelectItem key={i} value={String(i)} className="text-xs">{p.name} ({p.type})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input className="h-8 text-xs" value={newModelName} onChange={(e) => setNewModelName(e.target.value)} placeholder="My Model" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select value={newModelType} onValueChange={(v) => setNewModelType(v as GenerationType)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="image" className="text-xs">Image</SelectItem>
                      <SelectItem value="video" className="text-xs">Video</SelectItem>
                      <SelectItem value="3d" className="text-xs">3D Model</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">API Endpoint</Label>
                <Input className="h-8 text-xs font-mono" value={newModelEndpoint} onChange={(e) => setNewModelEndpoint(e.target.value)} placeholder="https://api.example.com/v1/generate" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">API Key</Label>
                <Input className="h-8 text-xs" type="password" value={newModelApiKey} onChange={(e) => setNewModelApiKey(e.target.value)} placeholder="sk-..." />
              </div>
              <Button size="sm" className="w-full h-8 text-xs" onClick={addModel}>Add Model</Button>
            </div>
          ) : filteredModels.length > 0 ? (
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select a model..." />
              </SelectTrigger>
              <SelectContent>
                {filteredModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground p-2 border rounded-md bg-muted/30">
              No {genType} models configured. Click &quot;+ Add Model&quot; to connect an API.
            </p>
          )}
        </div>

        {/* Prompt */}
        <div className="space-y-2">
          <Label>Prompt</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={genType === "3d" ? "A detailed 3D model of..." : genType === "video" ? "A cinematic shot of..." : "A beautiful painting of..."}
            rows={3}
          />
        </div>

        {genType !== "3d" && (
          <div className="space-y-2">
            <Label>Negative Prompt (optional)</Label>
            <Input
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="blurry, low quality, distorted..."
            />
          </div>
        )}

        {/* Generation params */}
        {genType === "image" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Width</Label>
              <Select value={String(width)} onValueChange={(v) => setWidth(Number(v))}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[256, 512, 768, 1024, 1280, 1536, 2048].map((s) => (
                    <SelectItem key={s} value={String(s)} className="text-xs">{s}px</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Height</Label>
              <Select value={String(height)} onValueChange={(v) => setHeight(Number(v))}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[256, 512, 768, 1024, 1280, 1536, 2048].map((s) => (
                    <SelectItem key={s} value={String(s)} className="text-xs">{s}px</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Steps: {steps}</Label>
              <Slider value={[steps]} min={1} max={100} step={1} onValueChange={(v) => setSteps(v[0])} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">CFG Scale: {cfgScale}</Label>
              <Slider value={[cfgScale]} min={1} max={20} step={0.5} onValueChange={(v) => setCfgScale(v[0])} />
            </div>
          </div>
        )}

        {/* Generate button */}
        <Button className="w-full gap-2" onClick={generate} disabled={isGenerating || !selectedModel}>
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Generate {genType === "3d" ? "3D Model" : genType.charAt(0).toUpperCase() + genType.slice(1)}
            </>
          )}
        </Button>

        {/* Result preview */}
        {result && (
          <div className="border rounded-md overflow-hidden">
            <div className="px-3 py-1.5 bg-muted/30 border-b flex items-center gap-2 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-yellow-500" />
              <span className="font-medium">Generated Result</span>
            </div>
            {genType === "image" ? (
              <>
                {/* Generated results may be transient data/blob URLs that next/image cannot optimize. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={result} alt={prompt} className="w-full" />
              </>
            ) : genType === "video" ? (
              <video src={result} controls className="w-full" />
            ) : (
              <div className="p-4 text-center text-sm">
                <a href={result} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
                  Download 3D Model
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

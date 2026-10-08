"use client"

import { useEffect, useRef, useState } from "react"
import {
  Download,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Box,
  Image as ImageIcon,
  Film,
  Music,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"

export type MediaType = "image" | "video" | "audio" | "3d" | "unknown"

const SAFE_MEDIA_PROTOCOLS = new Set(["http:", "https:", "blob:"])
const SAFE_INLINE_MEDIA = /^data:(?:image\/(?:png|jpeg|gif|webp|bmp|avif)|audio\/(?:mpeg|wav|ogg|flac|mp4)|video\/(?:mp4|webm|ogg));base64,/i

export function sanitizeMediaSource(src: string): string {
  const value = src.trim()
  if (!value) return ""
  if (SAFE_INLINE_MEDIA.test(value)) return value
  if (value.startsWith("/")) return value

  try {
    const url = new URL(value)
    return SAFE_MEDIA_PROTOCOLS.has(url.protocol) ? url.href : ""
  } catch {
    return ""
  }
}

/** Detect media type from MIME or filename */
export function detectMediaType(mimeType?: string, filename?: string): MediaType {
  const mime = (mimeType || "").toLowerCase()
  const ext = (filename || "").split(".").pop()?.toLowerCase() || ""

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"].includes(ext))
    return "image"
  if (mime.startsWith("video/") || ["mp4", "webm", "ogg", "mov", "avi", "mkv"].includes(ext))
    return "video"
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "aac", "flac", "m4a", "wma"].includes(ext))
    return "audio"
  if (["glb", "gltf", "obj", "fbx", "stl", "3ds", "usdz"].includes(ext))
    return "3d"
  return "unknown"
}

type MediaViewerProps = {
  /** Data URL, blob URL, or remote URL */
  src: string
  mediaType: MediaType
  title?: string
  className?: string
}

export function MediaViewer({ src, mediaType, title, className = "" }: MediaViewerProps) {
  const safeSrc = sanitizeMediaSource(src)
  if (!safeSrc) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <p className="text-muted-foreground">Unsupported or unsafe media source</p>
      </div>
    )
  }

  switch (mediaType) {
    case "image":
      return <ImageViewer src={safeSrc} title={title} className={className} />
    case "video":
      return <VideoPlayer src={safeSrc} title={title} className={className} />
    case "audio":
      return <AudioPlayer src={safeSrc} title={title} className={className} />
    case "3d":
      return <ModelViewer src={safeSrc} title={title} className={className} />
    default:
      return (
        <div className={`flex items-center justify-center p-8 ${className}`}>
          <p className="text-muted-foreground">Unsupported media type</p>
        </div>
      )
  }
}

// ─── Image Viewer ──────────────────────────────────────────────

function ImageViewer({ src, title, className }: { src: string; title?: string; className?: string }) {
  const [zoom, setZoom] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setZoom((z) => Math.max(0.1, Math.min(10, z - e.deltaY * 0.001)))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    setDragging(true)
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y })
  }

  const handleMouseUp = () => setDragging(false)

  const resetView = () => {
    setZoom(1)
    setPosition({ x: 0, y: 0 })
  }

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" />
          <span>{title || "Image"}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom((z) => Math.min(10, z + 0.25))}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={resetView}>
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <a href={src} download={title || "image"} className="inline-flex">
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Download className="h-3.5 w-3.5" />
            </Button>
          </a>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* The raw element is required for arbitrary data/blob sources and direct zoom/pan transforms. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={title || ""}
          className="max-w-none select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 0.15s ease",
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}

// ─── Video Player ──────────────────────────────────────────────

function VideoPlayer({ src, title, className }: { src: string; title?: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const togglePlay = () => {
    if (!videoRef.current) return
    if (playing) videoRef.current.pause()
    else videoRef.current.play()
    setPlaying(!playing)
  }

  const toggleMute = () => {
    if (!videoRef.current) return
    videoRef.current.muted = !muted
    setMuted(!muted)
  }

  const toggleFullscreen = () => {
    if (!containerRef.current) return
    if (!fullscreen) containerRef.current.requestFullscreen?.()
    else document.exitFullscreen?.()
    setFullscreen(!fullscreen)
  }

  const seek = (value: number[]) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = value[0]
    setCurrentTime(value[0])
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, "0")}`
  }

  return (
    <div ref={containerRef} className={`flex flex-col bg-black ${className}`}>
      <div className="flex-1 flex items-center justify-center relative cursor-pointer" onClick={togglePlay}>
        <video
          ref={videoRef}
          src={src}
          className="max-w-full max-h-full"
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
          onEnded={() => setPlaying(false)}
        />
        {!playing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Play className="h-16 w-16 text-white/80" />
          </div>
        )}
      </div>
      {/* Controls */}
      <div className="px-3 py-2 bg-gray-900 space-y-1">
        <Slider
          value={[currentTime]}
          min={0}
          max={duration || 1}
          step={0.1}
          onValueChange={seek}
          className="w-full"
        />
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white" onClick={togglePlay}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white" onClick={toggleMute}>
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
            <span className="tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">{title}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Audio Player ──────────────────────────────────────────────

function AudioPlayer({ src, title, className }: { src: string; title?: string; className?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const togglePlay = () => {
    if (!audioRef.current) return
    if (playing) audioRef.current.pause()
    else audioRef.current.play()
    setPlaying(!playing)
  }

  const seek = (value: number[]) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = value[0]
    setCurrentTime(value[0])
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, "0")}`
  }

  return (
    <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => setPlaying(false)}
      />
      <div className="w-full max-w-md space-y-4">
        <div className="flex flex-col items-center gap-2">
          <Music className="h-16 w-16 text-muted-foreground" />
          <h3 className="font-medium">{title || "Audio"}</h3>
        </div>
        <Slider
          value={[currentTime]}
          min={0}
          max={duration || 1}
          step={0.1}
          onValueChange={seek}
          className="w-full"
        />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span className="tabular-nums">{formatTime(currentTime)}</span>
          <Button variant="outline" size="icon" className="h-10 w-10" onClick={togglePlay}>
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>
          <span className="tabular-nums">{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── 3D Model Viewer (basic rotate preview) ────────────────────

function ModelViewer({ src, title, className }: { src: string; title?: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [rotation, setRotation] = useState(0)
  const animRef = useRef<number>(0)
  const dragging = useRef(false)
  const lastX = useRef(0)

  // Simple auto-rotate animation
  useEffect(() => {
    let frame: number
    const animate = () => {
      if (!dragging.current) {
        setRotation((r) => r + 0.5)
      }
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [])

  // Draw a simple 3D wireframe cube as placeholder visualization
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    const cx = w / 2
    const cy = h / 2
    const size = Math.min(w, h) * 0.25
    const rad = (rotation * Math.PI) / 180

    ctx.clearRect(0, 0, w, h)

    // Simple 3D cube projection
    const project = (x: number, y: number, z: number): [number, number] => {
      const cosR = Math.cos(rad)
      const sinR = Math.sin(rad)
      const rx = x * cosR - z * sinR
      const rz = x * sinR + z * cosR
      const cosP = Math.cos(0.4)
      const sinP = Math.sin(0.4)
      const ry = y * cosP - rz * sinP
      const depth = y * sinP + rz * cosP + 4
      const scale = 2 / depth
      return [cx + rx * size * scale, cy + ry * size * scale]
    }

    const vertices: [number, number, number][] = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ]
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ]

    const projected = vertices.map(([x, y, z]) => project(x, y, z))

    ctx.strokeStyle = "#6366f1"
    ctx.lineWidth = 2
    edges.forEach(([a, b]) => {
      ctx.beginPath()
      ctx.moveTo(projected[a][0], projected[a][1])
      ctx.lineTo(projected[b][0], projected[b][1])
      ctx.stroke()
    })

    // Vertices
    ctx.fillStyle = "#818cf8"
    projected.forEach(([px, py]) => {
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fill()
    })
  }, [rotation])

  const handleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true
    lastX.current = e.clientX
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - lastX.current
    setRotation((r) => r + dx * 0.5)
    lastX.current = e.clientX
  }

  const handleMouseUp = () => {
    dragging.current = false
  }

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Box className="h-3.5 w-3.5" />
          <span>{title || "3D Model"}</span>
        </div>
        <span className="text-[10px] bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 px-1.5 py-0.5 rounded font-medium">
          3D Preview
        </span>
      </div>
      <div
        className="flex-1 flex items-center justify-center bg-gray-950 cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <canvas
          ref={canvasRef}
          width={500}
          height={400}
          className="max-w-full"
        />
      </div>
      <div className="px-3 py-2 bg-gray-900 text-xs text-gray-400 text-center">
        Drag to rotate. For full 3D rendering, connect a Three.js or model-viewer integration.
      </div>
    </div>
  )
}

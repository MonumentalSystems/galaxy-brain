"use client"

import { useCallback, useEffect, useState } from "react"
import { Pause, Play, Square, Volume2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { ttsService, type TTSVoice } from "@/lib/tts-service"

type TextReaderProps = {
  /** Pre-filled text to read */
  initialText?: string
  onClose: () => void
  className?: string
}

export function TextReader({ initialText = "", onClose, className = "" }: TextReaderProps) {
  const [text, setText] = useState(initialText)
  const [voices, setVoices] = useState<TTSVoice[]>([])
  const [selectedVoice, setSelectedVoice] = useState("")
  const [rate, setRate] = useState(1)
  const [pitch, setPitch] = useState(1)
  const [volume, setVolume] = useState(1)
  const [isSpeaking, setIsSpeaking] = useState(false)

  // Load voices
  useEffect(() => {
    const availableVoices = ttsService.getVoices()
    setVoices(availableVoices)
    setSelectedVoice((voice) => voice || availableVoices[0]?.id || "")
  }, [])

  // Also listen for browser voices loading asynchronously
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return
    const handler = () => {
      const availableVoices = ttsService.getVoices()
      setVoices(availableVoices)
    }
    window.speechSynthesis.addEventListener("voiceschanged", handler)
    return () => window.speechSynthesis.removeEventListener("voiceschanged", handler)
  }, [])

  const handleSpeak = useCallback(async () => {
    if (!text.trim()) return

    if (isSpeaking) {
      ttsService.stop()
      setIsSpeaking(false)
      return
    }

    setIsSpeaking(true)
    try {
      await ttsService.speak(text, {
        voice: selectedVoice,
        rate,
        pitch,
        volume,
      })
    } catch (err) {
      console.error("TTS error:", err)
    } finally {
      setIsSpeaking(false)
    }
  }, [text, selectedVoice, rate, pitch, volume, isSpeaking])

  const handleStop = () => {
    ttsService.stop()
    setIsSpeaking(false)
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Text input */}
      <div className="flex-1 p-4 space-y-3">
        <Label>Text to Read</Label>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter or paste text to read aloud..."
          className="min-h-[200px] resize-none"
        />
        <p className="text-xs text-muted-foreground">{text.length} characters</p>
      </div>

      {/* Settings */}
      <div className="px-4 pb-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Voice</Label>
            <Select value={selectedVoice} onValueChange={setSelectedVoice}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select voice" />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.id} value={v.id} className="text-xs">
                    {v.name} ({v.locale})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Speed: {rate}x</Label>
            <Slider value={[rate]} min={0.25} max={3} step={0.25} onValueChange={(v) => setRate(v[0])} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Pitch: {pitch}</Label>
            <Slider value={[pitch]} min={0.5} max={2} step={0.1} onValueChange={(v) => setPitch(v[0])} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Volume: {Math.round(volume * 100)}%</Label>
            <Slider value={[volume]} min={0} max={1} step={0.1} onValueChange={(v) => setVolume(v[0])} />
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between p-4 border-t">
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        <div className="flex items-center gap-2">
          {isSpeaking && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleStop}>
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          )}
          <Button size="sm" className="gap-1.5" onClick={handleSpeak} disabled={!text.trim()}>
            {isSpeaking ? (
              <>
                <Pause className="h-4 w-4" />
                Speaking...
              </>
            ) : (
              <>
                <Volume2 className="h-4 w-4" />
                Read Aloud
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Hook for TTS in other components ──────────────────────────

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false)

  const speak = useCallback(async (text: string, voice?: string) => {
    if (isSpeaking) {
      ttsService.stop()
      setIsSpeaking(false)
      return
    }

    const voices = ttsService.getVoices()
    setIsSpeaking(true)
    try {
      await ttsService.speak(text, {
        voice: voice || voices[0]?.id || "en-US-AriaNeural",
        rate: 1,
        pitch: 1,
        volume: 1,
      })
    } catch {} finally {
      setIsSpeaking(false)
    }
  }, [isSpeaking])

  const stop = useCallback(() => {
    ttsService.stop()
    setIsSpeaking(false)
  }, [])

  return { speak, stop, isSpeaking }
}

import { safeLocalStorage } from "./browser-utils"

export type TTSVoice = {
  id: string
  name: string
  locale: string
  gender: "male" | "female" | "neutral"
  provider: "edge" | "elevenlabs" | "custom"
}

export type TTSOptions = {
  voice: string
  rate?: number
  pitch?: number
  volume?: number
}

export type TTSHistory = {
  id: string
  text: string
  voice: string
  audioUrl?: string
  createdAt: Date
}

// TTS service for text-to-speech conversion
export class TTSService {
  private readonly HISTORY_STORAGE_KEY = "flowiseTTSHistory"
  private readonly VOICES_STORAGE_KEY = "flowiseTTSVoices"
  private readonly DEFAULT_VOICES: TTSVoice[] = [
    // Microsoft Edge TTS voices
    { id: "en-US-AriaNeural", name: "Aria", locale: "en-US", gender: "female", provider: "edge" },
    { id: "en-US-GuyNeural", name: "Guy", locale: "en-US", gender: "male", provider: "edge" },
    { id: "en-US-JennyNeural", name: "Jenny", locale: "en-US", gender: "female", provider: "edge" },
    { id: "en-GB-SoniaNeural", name: "Sonia", locale: "en-GB", gender: "female", provider: "edge" },
    { id: "en-GB-RyanNeural", name: "Ryan", locale: "en-GB", gender: "male", provider: "edge" },
    { id: "fr-FR-DeniseNeural", name: "Denise", locale: "fr-FR", gender: "female", provider: "edge" },
    { id: "de-DE-KatjaNeural", name: "Katja", locale: "de-DE", gender: "female", provider: "edge" },
    { id: "es-ES-ElviraNeural", name: "Elvira", locale: "es-ES", gender: "female", provider: "edge" },
    { id: "it-IT-IsabellaNeural", name: "Isabella", locale: "it-IT", gender: "female", provider: "edge" },
    { id: "ja-JP-NanamiNeural", name: "Nanami", locale: "ja-JP", gender: "female", provider: "edge" },
  ]
  private audioContext: AudioContext | null = null
  private audioQueue: { text: string; options: TTSOptions }[] = []
  private isPlaying = false

  constructor() {
    // Initialize voices if not already set
    if (!safeLocalStorage().getItem(this.VOICES_STORAGE_KEY)) {
      safeLocalStorage().setItem(this.VOICES_STORAGE_KEY, JSON.stringify(this.DEFAULT_VOICES))
    }
  }

  // Get all available voices
  public getVoices(): TTSVoice[] {
    const voicesJson = safeLocalStorage().getItem(this.VOICES_STORAGE_KEY)
    if (!voicesJson) {
      return this.DEFAULT_VOICES
    }

    try {
      return JSON.parse(voicesJson)
    } catch (error) {
      console.error("Failed to parse voices:", error)
      return this.DEFAULT_VOICES
    }
  }

  // Add a custom voice
  public addVoice(voice: Omit<TTSVoice, "id" | "provider">): TTSVoice {
    const voices = this.getVoices()
    const newVoice: TTSVoice = {
      ...voice,
      id: `voice-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      provider: "custom",
    }

    safeLocalStorage().setItem(this.VOICES_STORAGE_KEY, JSON.stringify([...voices, newVoice]))
    return newVoice
  }

  // Remove a custom voice
  public removeVoice(id: string): boolean {
    const voices = this.getVoices()
    const voice = voices.find((v) => v.id === id)

    if (!voice || voice.provider !== "custom") {
      return false
    }

    const filteredVoices = voices.filter((v) => v.id !== id)
    safeLocalStorage().setItem(this.VOICES_STORAGE_KEY, JSON.stringify(filteredVoices))
    return true
  }

  // Get TTS history
  public getHistory(): TTSHistory[] {
    const historyJson = safeLocalStorage().getItem(this.HISTORY_STORAGE_KEY)
    if (!historyJson) {
      return []
    }

    try {
      const history = JSON.parse(historyJson)
      return history.map((item: any) => ({
        ...item,
        createdAt: new Date(item.createdAt),
      }))
    } catch (error) {
      console.error("Failed to parse TTS history:", error)
      return []
    }
  }

  // Clear TTS history
  public clearHistory(): void {
    safeLocalStorage().removeItem(this.HISTORY_STORAGE_KEY)
  }

  // Speak text using Microsoft Edge TTS
  public async speak(text: string, options: TTSOptions): Promise<void> {
    // Add to queue
    this.audioQueue.push({ text, options })

    // Start processing queue if not already playing
    if (!this.isPlaying) {
      this.processQueue()
    }

    // Add to history
    const history = this.getHistory()
    const newHistoryItem: TTSHistory = {
      id: `tts-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      text,
      voice: options.voice,
      createdAt: new Date(),
    }

    safeLocalStorage().setItem(this.HISTORY_STORAGE_KEY, JSON.stringify([newHistoryItem, ...history].slice(0, 50)))
  }

  // Stop speaking
  public stop(): void {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    this.audioQueue = []
    this.isPlaying = false
  }

  // Process the audio queue
  private async processQueue(): Promise<void> {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false
      return
    }

    this.isPlaying = true
    const { text, options } = this.audioQueue.shift()!

    try {
      await this.synthesizeSpeech(text, options)
    } catch (error) {
      console.error("Failed to synthesize speech:", error)
    }

    // Process next item in queue
    this.processQueue()
  }

  // Synthesize speech using the browser's SpeechSynthesis API
  private async synthesizeSpeech(text: string, options: TTSOptions): Promise<void> {
    if (!("speechSynthesis" in window)) {
      console.error("SpeechSynthesis API is not supported in this browser")
      return
    }

    // Cancel any ongoing speech first
    window.speechSynthesis.cancel()

    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)

      // Voices may not be loaded yet; wait for them
      const attemptSetVoice = () => {
        const voices = window.speechSynthesis.getVoices()
        if (voices.length > 0) {
          // Try exact voice ID match, then name match, then locale match
          const voice =
            voices.find((v) => v.name === options.voice) ||
            voices.find((v) => v.name.includes(options.voice)) ||
            voices.find((v) => v.lang === options.voice.split("-").slice(0, 2).join("-")) ||
            voices.find((v) => v.lang.startsWith(options.voice.split("-")[0]))
          if (voice) utterance.voice = voice
        }
      }

      // Try to set voice immediately
      attemptSetVoice()

      // If voices weren't loaded, listen for the event and try again
      if (!utterance.voice) {
        window.speechSynthesis.addEventListener("voiceschanged", attemptSetVoice, { once: true })
      }

      if (options.rate) utterance.rate = Math.max(0.1, Math.min(10, options.rate))
      if (options.pitch) utterance.pitch = Math.max(0, Math.min(2, options.pitch))
      if (options.volume) utterance.volume = Math.max(0, Math.min(1, options.volume))

      utterance.onend = () => resolve()
      utterance.onerror = (event) => {
        if (event.error === "canceled") {
          resolve() // Not a real error, user stopped playback
        } else {
          console.error("SpeechSynthesis error:", event.error)
          reject(new Error(`Speech synthesis failed: ${event.error}`))
        }
      }

      window.speechSynthesis.speak(utterance)
    })
  }
}

// Export a singleton instance
export const ttsService = new TTSService()

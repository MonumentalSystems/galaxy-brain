import { safeLocalStorage } from "./browser-utils"
import { weaviateService, type KnowledgeNode } from "./weaviate-service"

// ─── Types ─────────────────────────────────────────────────────

export type ProcessingStatus = "pending" | "processing" | "completed" | "failed"

export type ProcessedContent = {
  /** Cleaned, normalized text ready for LLM consumption */
  cleanText: string
  /** Content split into overlapping chunks for embedding */
  chunks: ContentChunk[]
  /** Simple TF-based embedding vector (per-chunk) */
  embeddings: number[][]
  /** Auto-extracted keywords / entities */
  keywords: string[]
  /** Auto-generated summary (first ~200 chars of meaningful content) */
  summary: string
  /** Detected language */
  language: string
  /** Word count of the original content */
  wordCount: number
  /** Processing timestamp */
  processedAt: string
}

export type ContentChunk = {
  id: string
  text: string
  index: number
  /** Character offset in original content */
  startOffset: number
  endOffset: number
  /** Simple TF vector for this chunk */
  embedding: number[]
}

// ─── Configuration ─────────────────────────────────────────────

const PROCESSING_KEY = "galaxyProcessedContent"
const CONFIG_KEY = "galaxyProcessingConfig"

export type ProcessingConfig = {
  chunkSize: number
  chunkOverlap: number
  autoProcess: boolean
  extractKeywords: boolean
  generateSummary: boolean
  /** Vocabulary size for TF embeddings */
  vocabSize: number
}

function getConfig(): ProcessingConfig {
  try {
    const stored = safeLocalStorage().getItem(CONFIG_KEY)
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }
  } catch {}
  return DEFAULT_CONFIG
}

const DEFAULT_CONFIG: ProcessingConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  autoProcess: true,
  extractKeywords: true,
  generateSummary: true,
  vocabSize: 256,
}

// ─── Processing Service ────────────────────────────────────────

export class ContentProcessingService {
  private processedCache: Map<string, ProcessedContent> = new Map()
  private processingQueue: string[] = []
  private isProcessing = false

  constructor() {
    this.loadFromStorage()
  }

  // ── Public API ──────────────────────────────────────────────

  /** Process a node's content and store the results */
  public async processNode(nodeId: string): Promise<ProcessedContent | null> {
    const node = weaviateService.getNode(nodeId)
    if (!node) return null

    const content = this.extractTextContent(node)
    if (!content.trim()) return null

    const config = getConfig()
    const processed = this.processText(content, config, node)

    this.processedCache.set(nodeId, processed)
    this.saveToStorage()

    // Auto-tag the node with extracted keywords
    if (config.extractKeywords && processed.keywords.length > 0) {
      const existingTags = new Set(node.tags)
      const newTags = processed.keywords.filter((k) => !existingTags.has(k))
      if (newTags.length > 0) {
        weaviateService.updateNode(nodeId, {
          tags: [...node.tags, ...newTags.slice(0, 10)],
        })
      }
    }

    // Store summary in metadata
    if (config.generateSummary && processed.summary) {
      weaviateService.updateNode(nodeId, {
        metadata: {
          ...node.metadata,
          processedAt: processed.processedAt,
          summary: processed.summary,
          wordCount: processed.wordCount,
          language: processed.language,
          chunkCount: processed.chunks.length,
        },
      })
    }

    // Enrich HAM memory with extracted keywords + summary (fallback for BitNet)
    const hamMemoryId = node.metadata?.hamMemoryId
    if (hamMemoryId && (processed.keywords.length > 0 || processed.summary)) {
      weaviateService.hamEnrich(hamMemoryId, processed.keywords, processed.summary)
        .catch((err: any) => console.error("HAM enrich failed:", err))
    }

    return processed
  }

  /** Queue a node for background processing */
  public enqueueNode(nodeId: string): void {
    if (this.processingQueue.includes(nodeId)) return
    this.processingQueue.push(nodeId)
    this.drainQueue()
  }

  /** Get processed content for a node */
  public getProcessed(nodeId: string): ProcessedContent | null {
    return this.processedCache.get(nodeId) || null
  }

  /** Check if a node has been processed */
  public isProcessed(nodeId: string): boolean {
    return this.processedCache.has(nodeId)
  }

  /** Reprocess all nodes */
  public async reprocessAll(): Promise<number> {
    const nodes = weaviateService.getNodes()
    let count = 0
    for (const node of nodes) {
      const content = this.extractTextContent(node)
      if (content.trim()) {
        await this.processNode(node.id)
        count++
      }
    }
    return count
  }

  /** Semantic search using chunk embeddings */
  public semanticSearch(query: string, limit = 10): Array<{ nodeId: string; chunkId: string; chunk: ContentChunk; score: number }> {
    const config = getConfig()
    const queryEmbedding = this.computeTFVector(this.normalizeText(query), config.vocabSize)
    const results: Array<{ nodeId: string; chunkId: string; chunk: ContentChunk; score: number }> = []

    for (const [nodeId, processed] of this.processedCache) {
      for (const chunk of processed.chunks) {
        const score = this.cosineSimilarity(queryEmbedding, chunk.embedding)
        if (score > 0.05) {
          results.push({ nodeId, chunkId: chunk.id, chunk, score })
        }
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Get the full LLM-ready context for a node */
  public getLLMContext(nodeId: string): string {
    const processed = this.processedCache.get(nodeId)
    if (!processed) {
      const node = weaviateService.getNode(nodeId)
      return node ? this.extractTextContent(node) : ""
    }
    return processed.cleanText
  }

  /** Get chunks for RAG-style retrieval */
  public getRelevantChunks(query: string, topK = 5): Array<{ nodeId: string; text: string; score: number }> {
    return this.semanticSearch(query, topK).map((r) => ({
      nodeId: r.nodeId,
      text: r.chunk.text,
      score: r.score,
    }))
  }

  /**
   * Hybrid search: combines keyword search (weaviate) with semantic search (embeddings).
   * Returns deduplicated results ranked by combined score.
   */
  public hybridSearch(query: string, limit = 10): Array<{ nodeId: string; node: KnowledgeNode; score: number; matchedChunks: string[] }> {
    // 1. Keyword search from weaviate
    const keywordResults = weaviateService.searchNodes(query, limit)
    const resultMap = new Map<string, { node: KnowledgeNode; score: number; matchedChunks: string[] }>()

    for (const kr of keywordResults) {
      resultMap.set(kr.node.id, {
        node: kr.node,
        score: kr.score,
        matchedChunks: [],
      })
    }

    // 2. Semantic search from embeddings
    const semanticResults = this.semanticSearch(query, limit * 2)

    for (const sr of semanticResults) {
      const existing = resultMap.get(sr.nodeId)
      if (existing) {
        // Boost score when both keyword and semantic match
        existing.score += sr.score * 5
        existing.matchedChunks.push(sr.chunk.text)
      } else {
        const node = weaviateService.getNode(sr.nodeId)
        if (node) {
          resultMap.set(sr.nodeId, {
            node,
            score: sr.score * 3,
            matchedChunks: [sr.chunk.text],
          })
        }
      }
    }

    return Array.from(resultMap.entries())
      .map(([nodeId, data]) => ({ nodeId, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Get processing stats */
  public getStats(): { totalProcessed: number; totalChunks: number; totalKeywords: number } {
    let totalChunks = 0
    let totalKeywords = 0
    for (const processed of this.processedCache.values()) {
      totalChunks += processed.chunks.length
      totalKeywords += processed.keywords.length
    }
    return {
      totalProcessed: this.processedCache.size,
      totalChunks,
      totalKeywords,
    }
  }

  // ── Text Extraction ─────────────────────────────────────────

  /** Extract clean text from any node type */
  private extractTextContent(node: KnowledgeNode): string {
    const parts: string[] = []

    // Title is always relevant
    if (node.title) parts.push(node.title)

    // Main content
    if (node.content) {
      // Check if content is JSON (notebook cells, canvas state)
      if (node.content.startsWith("[") || node.content.startsWith("{")) {
        try {
          const parsed = JSON.parse(node.content)
          // Notebook cells
          if (Array.isArray(parsed) && parsed[0]?.type) {
            for (const cell of parsed) {
              if (cell.content) parts.push(cell.content)
              if (cell.output) parts.push(cell.output)
            }
          }
          // Canvas state — extract text elements
          else if (parsed.elements) {
            for (const el of parsed.elements) {
              if ("text" in el && el.text) parts.push(el.text)
            }
          }
        } catch {
          // Not valid JSON, treat as plain text
          if (!node.content.startsWith("data:")) {
            parts.push(node.content)
          }
        }
      }
      // Skip data URLs (media content)
      else if (!node.content.startsWith("data:")) {
        parts.push(node.content)
      }
    }

    // Extract text from metadata fields
    if (node.metadata) {
      if (node.metadata.prompt) parts.push(`Prompt: ${node.metadata.prompt}`)
      if (node.metadata.summary) parts.push(node.metadata.summary)
      if (node.metadata.description) parts.push(node.metadata.description)
    }

    // Tags as context
    if (node.tags.length > 0) {
      parts.push(`Tags: ${node.tags.join(", ")}`)
    }

    return parts.join("\n\n")
  }

  // ── Core Processing ─────────────────────────────────────────

  private processText(rawText: string, config: ProcessingConfig, node: KnowledgeNode): ProcessedContent {
    // 1. Clean and normalize
    const cleanText = this.cleanText(rawText)

    // 2. Detect language
    const language = this.detectLanguage(cleanText)

    // 3. Word count
    const wordCount = cleanText.split(/\s+/).filter(Boolean).length

    // 4. Generate summary
    const summary = config.generateSummary ? this.generateSummary(cleanText, node) : ""

    // 5. Extract keywords
    const keywords = config.extractKeywords ? this.extractKeywords(cleanText) : []

    // 6. Chunk the text
    const chunks = this.chunkText(cleanText, config)

    // 7. Compute TF embeddings for each chunk
    const embeddings = chunks.map((c) => c.embedding)

    return {
      cleanText,
      chunks,
      embeddings,
      keywords,
      summary,
      language,
      wordCount,
      processedAt: new Date().toISOString(),
    }
  }

  // ── Text Cleaning ───────────────────────────────────────────

  private stripHtmlTags(text: string): string {
    let result = ""
    let insideTag = false
    for (const character of text) {
      if (character === "<") {
        insideTag = true
      } else if (character === ">") {
        insideTag = false
      } else if (!insideTag) {
        result += character
      }
    }
    return result
  }

  private cleanText(text: string): string {
    const normalized = text
      // Normalize unicode
      .normalize("NFKC")
      // Remove null bytes
      .replace(/\0/g, "")
      // Normalize whitespace (keep newlines for structure)
      .replace(/[ \t]+/g, " ")
      // Remove excessive newlines (3+ → 2)
      .replace(/\n{3,}/g, "\n\n")
      // Remove markdown image syntax but keep alt text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")

    return this.stripHtmlTags(normalized)
      // Remove markdown link syntax but keep text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Clean up markdown formatting (keep the text)
      .replace(/[*_~`]{1,3}([^*_~`]+)[*_~`]{1,3}/g, "$1")
      .trim()
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }

  // ── Chunking ────────────────────────────────────────────────

  private chunkText(text: string, config: ProcessingConfig): ContentChunk[] {
    const { chunkSize, chunkOverlap, vocabSize } = config
    const chunks: ContentChunk[] = []

    if (text.length <= chunkSize) {
      const embedding = this.computeTFVector(this.normalizeText(text), vocabSize)
      chunks.push({
        id: `chunk-0`,
        text,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        embedding,
      })
      return chunks
    }

    // Sentence-aware chunking: try to break at sentence boundaries
    const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text]
    let currentChunk = ""
    let startOffset = 0
    let charPos = 0

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
        const normalized = this.normalizeText(currentChunk)
        const embedding = this.computeTFVector(normalized, vocabSize)
        chunks.push({
          id: `chunk-${chunks.length}`,
          text: currentChunk.trim(),
          index: chunks.length,
          startOffset,
          endOffset: charPos,
          embedding,
        })

        // Overlap: keep last N characters
        const overlapText = currentChunk.slice(-chunkOverlap)
        startOffset = charPos - overlapText.length
        currentChunk = overlapText
      }
      currentChunk += sentence
      charPos += sentence.length
    }

    // Final chunk
    if (currentChunk.trim()) {
      const normalized = this.normalizeText(currentChunk)
      const embedding = this.computeTFVector(normalized, vocabSize)
      chunks.push({
        id: `chunk-${chunks.length}`,
        text: currentChunk.trim(),
        index: chunks.length,
        startOffset,
        endOffset: charPos,
        embedding,
      })
    }

    return chunks
  }

  // ── TF Embedding ────────────────────────────────────────────

  /** Compute a term-frequency vector using hashing trick */
  private computeTFVector(normalizedText: string, vocabSize: number): number[] {
    const vec = new Float32Array(vocabSize)
    const words = normalizedText.split(/\s+/).filter(Boolean)
    if (words.length === 0) return Array.from(vec)

    for (const word of words) {
      const hash = this.hashWord(word, vocabSize)
      vec[hash] += 1
    }

    // L2 normalize
    let norm = 0
    for (let i = 0; i < vocabSize; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < vocabSize; i++) vec[i] /= norm
    }

    return Array.from(vec)
  }

  private hashWord(word: string, vocabSize: number): number {
    let hash = 0
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0
    }
    return ((hash % vocabSize) + vocabSize) % vocabSize
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom > 0 ? dot / denom : 0
  }

  // ── Keyword Extraction ──────────────────────────────────────

  private extractKeywords(text: string, maxKeywords = 15): string[] {
    const normalized = this.normalizeText(text)
    const words = normalized.split(/\s+/).filter((w) => w.length > 2)

    // Stopwords
    const stopwords = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her",
      "was", "one", "our", "out", "has", "have", "been", "from", "they", "will", "with",
      "this", "that", "each", "make", "like", "long", "look", "many", "then", "them",
      "than", "some", "what", "when", "who", "how", "its", "into", "just", "also",
      "more", "other", "would", "about", "could", "which", "their", "there", "these",
      "those", "after", "before", "between", "through", "during", "without", "again",
      "further", "once", "here", "where", "why", "above", "below", "does", "doing",
      "very", "most", "such", "only", "same", "over", "should", "under", "while",
    ])

    // Count word frequencies
    const freq: Record<string, number> = {}
    for (const word of words) {
      if (stopwords.has(word)) continue
      if (/^\d+$/.test(word)) continue
      freq[word] = (freq[word] || 0) + 1
    }

    // Score by frequency * word length (longer words tend to be more specific)
    const scored = Object.entries(freq)
      .map(([word, count]) => ({ word, score: count * Math.log(word.length + 1) }))
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, maxKeywords).map((s) => s.word)
  }

  // ── Summary Generation ──────────────────────────────────────

  private generateSummary(text: string, node: KnowledgeNode): string {
    // Take the first meaningful paragraph (skip headings)
    const lines = text.split("\n").filter((l) => {
      const trimmed = l.trim()
      return trimmed.length > 20 && !trimmed.startsWith("#") && !trimmed.startsWith("---")
    })

    const firstParagraph = lines[0] || text.substring(0, 200)
    const summary = firstParagraph.length > 200
      ? firstParagraph.substring(0, 197) + "..."
      : firstParagraph

    return summary.trim()
  }

  // ── Language Detection ──────────────────────────────────────

  private detectLanguage(text: string): string {
    const sample = text.substring(0, 500).toLowerCase()

    // Simple heuristic based on common word patterns
    const patterns: Record<string, RegExp[]> = {
      "en": [/\bthe\b/, /\band\b/, /\bfor\b/, /\bthat\b/, /\bwith\b/],
      "es": [/\bque\b/, /\bdel\b/, /\blos\b/, /\blas\b/, /\buna\b/],
      "fr": [/\bles\b/, /\bdes\b/, /\bune\b/, /\bpour\b/, /\bdans\b/],
      "de": [/\bdie\b/, /\bder\b/, /\bdas\b/, /\bund\b/, /\bein\b/],
      "ja": [/[\u3040-\u309f]/, /[\u30a0-\u30ff]/],
      "zh": [/[\u4e00-\u9fff]/],
      "ko": [/[\uac00-\ud7af]/],
    }

    let best = "en"
    let bestScore = 0

    for (const [lang, regexes] of Object.entries(patterns)) {
      const score = regexes.reduce((acc, r) => acc + (r.test(sample) ? 1 : 0), 0)
      if (score > bestScore) {
        bestScore = score
        best = lang
      }
    }

    return best
  }

  // ── Media Content Extraction ────────────────────────────────

  /** Extract descriptive text from media nodes for indexing */
  public extractMediaDescription(node: KnowledgeNode): string {
    const parts: string[] = []

    parts.push(`${node.type}: ${node.title}`)

    if (node.metadata) {
      if (node.metadata.mimeType) parts.push(`Format: ${node.metadata.mimeType}`)
      if (node.metadata.fileSize) {
        const sizeMB = (node.metadata.fileSize / (1024 * 1024)).toFixed(2)
        parts.push(`Size: ${sizeMB} MB`)
      }
      if (node.metadata.fileName) parts.push(`File: ${node.metadata.fileName}`)
      if (node.metadata.prompt) parts.push(`Generated from prompt: ${node.metadata.prompt}`)
      if (node.metadata.generatedBy) parts.push(`Model: ${node.metadata.generatedBy}`)

      // Image-specific
      if (node.metadata.width && node.metadata.height) {
        parts.push(`Dimensions: ${node.metadata.width}x${node.metadata.height}`)
      }

      // Audio/video specific
      if (node.metadata.duration) parts.push(`Duration: ${node.metadata.duration}s`)
    }

    // Auto-label based on file extension
    const ext = node.title.split(".").pop()?.toLowerCase() || ""
    const formatLabels: Record<string, string> = {
      png: "PNG raster image", jpg: "JPEG photograph", jpeg: "JPEG photograph",
      gif: "GIF animated image", svg: "SVG vector graphic", webp: "WebP image",
      mp4: "MP4 video", webm: "WebM video", mov: "QuickTime video",
      mp3: "MP3 audio", wav: "WAV audio", flac: "FLAC lossless audio",
      glb: "GLB 3D model", gltf: "glTF 3D model", obj: "OBJ 3D model",
      stl: "STL 3D print model", fbx: "FBX 3D model",
      pdf: "PDF document",
    }
    if (formatLabels[ext]) parts.push(`Type: ${formatLabels[ext]}`)

    return parts.join(". ")
  }

  /** Process a media node — extract metadata and create searchable description */
  public async processMediaNode(nodeId: string): Promise<void> {
    const node = weaviateService.getNode(nodeId)
    if (!node) return

    const description = this.extractMediaDescription(node)
    const config = getConfig()

    // For images with data URLs, try to extract dimensions
    if (node.type === "image" && node.metadata?.dataUrl?.startsWith("data:image")) {
      try {
        const dimensions = await this.getImageDimensions(node.metadata.dataUrl)
        weaviateService.updateNode(nodeId, {
          metadata: {
            ...node.metadata,
            width: dimensions.width,
            height: dimensions.height,
          },
        })
      } catch {}
    }

    // Store the description as processed content
    const processed = this.processText(description, config, node)
    this.processedCache.set(nodeId, processed)
    this.saveToStorage()

    // Auto-tag media based on type
    const autoTags: string[] = []
    if (node.type === "image") autoTags.push("image", "visual")
    if (node.type === "video") autoTags.push("video", "visual", "media")
    if (node.type === "audio") autoTags.push("audio", "media")
    if (node.type === "3d") autoTags.push("3d", "model", "visual")

    const existingTags = new Set(node.tags)
    const newTags = autoTags.filter((t) => !existingTags.has(t))
    if (newTags.length > 0) {
      weaviateService.updateNode(nodeId, {
        tags: [...node.tags, ...newTags],
      })
    }
  }

  private getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined") return reject()
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = reject
      img.src = dataUrl
    })
  }

  // ── Background Queue ────────────────────────────────────────

  private async drainQueue(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.processingQueue.length > 0) {
      const nodeId = this.processingQueue.shift()!
      try {
        const node = weaviateService.getNode(nodeId)
        if (!node) continue

        if (["image", "video", "audio", "3d"].includes(node.type)) {
          await this.processMediaNode(nodeId)
        } else {
          await this.processNode(nodeId)
        }
      } catch (err) {
        console.error(`Failed to process node ${nodeId}:`, err)
      }
    }

    this.isProcessing = false
  }

  // ── Persistence ─────────────────────────────────────────────

  private saveToStorage(): void {
    try {
      const entries: Record<string, ProcessedContent> = {}
      // Only save non-embedding data to keep storage small
      for (const [id, processed] of this.processedCache) {
        entries[id] = {
          ...processed,
          // Store embeddings compactly (reduce precision)
          embeddings: processed.embeddings.map((e) =>
            e.map((v) => Math.round(v * 1000) / 1000)
          ),
          chunks: processed.chunks.map((c) => ({
            ...c,
            embedding: c.embedding.map((v) => Math.round(v * 1000) / 1000),
          })),
        }
      }
      safeLocalStorage().setItem(PROCESSING_KEY, JSON.stringify(entries))
    } catch {
      // Storage full — clear old entries
      console.warn("Storage full, clearing processed content cache")
      this.processedCache.clear()
    }
  }

  private loadFromStorage(): void {
    try {
      const data = safeLocalStorage().getItem(PROCESSING_KEY)
      if (!data) return
      const entries = JSON.parse(data) as Record<string, ProcessedContent>
      for (const [id, content] of Object.entries(entries)) {
        this.processedCache.set(id, content)
      }
    } catch {}
  }
}

// Export singleton
export const contentProcessingService = new ContentProcessingService()

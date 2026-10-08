"use client"

import type React from "react"

import { useState } from "react"
import { Box, File, FileCode, FileText, Film, Music, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/use-toast"
import { contentProcessingService } from "@/lib/content-processing-service"
import { type NodeType, weaviateService } from "@/lib/weaviate-service"
import { extractPDFText } from "@/components/pdf-viewer"
import { CONVERTIBLE_ACCEPT, canConvert, convertFile } from "@/lib/markitdown-service"

/**
 * What the picker offers: everything MarkItDown converts, plus the media,
 * model and source formats this component stores directly.
 */
const DIRECT_ACCEPT = [
  CONVERTIBLE_ACCEPT,
  ".md,.mdx,.markdown,.txt,.ts,.tsx,.js,.jsx,.py,.go,.rs,.css,.svg,.avif",
  ".mp4,.webm,.mov,.avi,.mkv,.aac",
  ".glb,.gltf,.obj,.fbx,.stl,.usdz",
].join(",")

export function DocumentUpload() {
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files)
      setFiles((prev) => [...prev, ...newFiles])
    }
  }

  // Handle file drop
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)

    if (e.dataTransfer.files) {
      const newFiles = Array.from(e.dataTransfer.files)
      setFiles((prev) => [...prev, ...newFiles])
    }
  }

  // Handle drag events
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  // Remove a file
  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const isMarkdownFile = (file: File): boolean => {
    const name = file.name.toLowerCase()
    return name.endsWith(".md") || name.endsWith(".mdx") || name.endsWith(".markdown")
  }

  const isPDFFile = (file: File): boolean => {
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  }

  const isVideoFile = (file: File): boolean => {
    return file.type.startsWith("video/") || /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(file.name)
  }

  const isAudioFile = (file: File): boolean => {
    return file.type.startsWith("audio/") || /\.(mp3|wav|ogg|aac|flac|m4a|wma)$/i.test(file.name)
  }

  const is3DFile = (file: File): boolean => {
    return /\.(glb|gltf|obj|fbx|stl|3ds|usdz)$/i.test(file.name)
  }

  // Determine node type from file MIME type
  const getNodeType = (file: File): NodeType => {
    if (file.type.startsWith("image/")) return "image"
    if (isVideoFile(file)) return "video"
    if (isAudioFile(file)) return "audio"
    if (is3DFile(file)) return "3d"
    if (
      file.name.endsWith(".ts") || file.name.endsWith(".tsx") ||
      file.name.endsWith(".js") || file.name.endsWith(".jsx") ||
      file.name.endsWith(".py") || file.name.endsWith(".go") ||
      file.name.endsWith(".rs") || file.name.endsWith(".json") ||
      file.name.endsWith(".css") || file.name.endsWith(".html")
    ) return "code"
    return "document"
  }

  const isMediaFile = (file: File): boolean => {
    return file.type.startsWith("image/") || isVideoFile(file) || isAudioFile(file) || is3DFile(file)
  }

  // Read file content as text (for text-based files) or data URL (for binary/media)
  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      if (file.type.startsWith("text/") || getNodeType(file) === "code" || isMarkdownFile(file)) {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsText(file)
      } else {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      }
    })
  }

  // Upload files
  const uploadFiles = async () => {
    if (files.length === 0) {
      toast({
        title: "No files selected",
        description: "Please select at least one file to upload",
        variant: "destructive",
      })
      return
    }

    setIsUploading(true)
    let successCount = 0
    let failCount = 0

    for (const file of files) {
      try {
        let content: string
        const extension = file.name.split(".").pop()?.toLowerCase() || ""
        const tags: string[] = [extension, "uploaded"]
        const metadata: Record<string, any> = {
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          uploadedAt: new Date().toISOString(),
        }

        if (isPDFFile(file)) {
          // Extract text content from PDF
          const pdfText = await extractPDFText(file)
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(file)
          })
          content = pdfText
          tags.push("pdf", "document")
          metadata.pdfDataUrl = dataUrl
          metadata.isPDF = true
          metadata.pageCount = pdfText.split("\n\n").length
        } else if (isMarkdownFile(file)) {
          content = await readFileContent(file)
          tags.push("markdown", "document")
          metadata.isMarkdown = true
        } else if (isMediaFile(file)) {
          // Store media files as data URLs in metadata for the viewer
          const dataUrl = await readFileContent(file)
          content = ""
          const mediaType = getNodeType(file)
          tags.push(mediaType)
          metadata.dataUrl = dataUrl
        } else if (canConvert(file.name)) {
          /*
            Offering a spreadsheet in the picker is not the same as ingesting
            one. Without this the file fell through to the branch below and was
            stored as a base64 data URL, so a document the converter handles
            perfectly well arrived as an unsearchable blob.
          */
          const converted = await convertFile(file)
          if (converted) {
            content = converted.markdown
            tags.push("document", "converted")
            metadata.convertedFrom = file.name
            metadata.converter = "markitdown"
          } else {
            // The converter is optional; keep the file rather than lose it.
            content = await readFileContent(file)
            tags.push(getNodeType(file))
            metadata.conversionUnavailable = true
          }
        } else {
          content = await readFileContent(file)
          tags.push(getNodeType(file))
        }

        const nodeType = getNodeType(file)

        const createdNode = weaviateService.createNode(
          nodeType,
          file.name,
          content,
          undefined,
          undefined,
          undefined,
          [...new Set(tags)],
          metadata,
        )
        contentProcessingService.enqueueNode(createdNode.id)
        successCount++
      } catch {
        failCount++
      }
    }

    setIsUploading(false)

    if (failCount > 0) {
      toast({
        title: "Upload partially complete",
        description: `${successCount} file(s) saved, ${failCount} failed`,
        variant: "destructive",
      })
    } else {
      toast({
        title: "Files uploaded",
        description: `${successCount} file(s) have been saved to your knowledge base`,
      })
    }

    setFiles([])
  }

  return (
    <div className="space-y-4">
      <div
        className={`border-2 border-dashed rounded-md p-6 text-center ${
          isDragging ? "border-primary bg-primary/10" : "border-muted-foreground/25"
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <h4 className="text-sm font-medium">Drag and drop files here</h4>
        <p className="text-xs text-muted-foreground mt-1">Supports documents and spreadsheets, PDFs, Markdown, images, media, 3D models, code, and text</p>
        <input type="file" multiple className="hidden" id="file-upload" accept={DIRECT_ACCEPT} onChange={handleFileSelect} />
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => document.getElementById("file-upload")?.click()}
        >
          Browse Files
        </Button>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Selected Files</h4>
          <div className="space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between rounded-md border p-2">
                <div className="flex items-center gap-2">
                  {isPDFFile(file) ? (
                    <FileText className="h-4 w-4 text-red-500" />
                  ) : isMarkdownFile(file) ? (
                    <FileCode className="h-4 w-4 text-blue-500" />
                  ) : isVideoFile(file) ? (
                    <Film className="h-4 w-4 text-purple-500" />
                  ) : isAudioFile(file) ? (
                    <Music className="h-4 w-4 text-green-500" />
                  ) : is3DFile(file) ? (
                    <Box className="h-4 w-4 text-indigo-500" />
                  ) : (
                    <File className="h-4 w-4" />
                  )}
                  <span className="text-sm">{file.name}</span>
                  {isPDFFile(file) && (
                    <span className="text-[10px] bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded font-medium">PDF</span>
                  )}
                  {isMarkdownFile(file) && (
                    <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">MD</span>
                  )}
                  {isVideoFile(file) && (
                    <span className="text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 px-1.5 py-0.5 rounded font-medium">Video</span>
                  )}
                  {isAudioFile(file) && (
                    <span className="text-[10px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded font-medium">Audio</span>
                  )}
                  {is3DFile(file) && (
                    <span className="text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 px-1.5 py-0.5 rounded font-medium">3D</span>
                  )}
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeFile(index)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button className="w-full" onClick={uploadFiles} disabled={isUploading}>
            {isUploading ? "Uploading..." : `Upload ${files.length} File(s)`}
          </Button>
        </div>
      )}
    </div>
  )
}

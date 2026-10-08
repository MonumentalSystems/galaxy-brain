"use client"

import { useState } from "react"
import { Eye, FileText, Pen, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { contentProcessingService } from "@/lib/content-processing-service"
import { weaviateService } from "@/lib/weaviate-service"

type DocumentCreatorProps = {
  flowId?: string
  onDocumentCreated?: (nodeId: string) => void
}

type DocumentTemplate = {
  id: string
  name: string
  description: string
  content: string
  type: "blog" | "email" | "report" | "markdown" | "custom"
}

const templates: DocumentTemplate[] = [
  {
    id: "template-1",
    name: "Blog Post",
    description: "A standard blog post template with title, intro, and sections",
    content:
      "# [Title]\n\n## Introduction\n\n[Your introduction here]\n\n## Section 1\n\n[Content for section 1]\n\n## Section 2\n\n[Content for section 2]\n\n## Conclusion\n\n[Your conclusion here]",
    type: "blog",
  },
  {
    id: "template-2",
    name: "Email Newsletter",
    description: "A template for email newsletters",
    content: "Subject: [Your Subject Line]\n\nHello [Name],\n\n[Main content here]\n\nBest regards,\n[Your Name]",
    type: "email",
  },
  {
    id: "template-4",
    name: "Analysis Report",
    description: "A template for data analysis reports",
    content:
      "# [Report Title]\n\n## Executive Summary\n\n[Summary here]\n\n## Data Analysis\n\n[Analysis details]\n\n## Findings\n\n[Key findings]\n\n## Recommendations\n\n[Recommendations based on findings]",
    type: "report",
  },
  {
    id: "template-5",
    name: "Markdown Doc",
    description: "A rich markdown document with common formatting examples",
    content: `# Document Title

## Overview

Write your overview here. You can use **bold**, *italic*, and \`inline code\`.

## Key Points

- First point
- Second point
- Third point

## Details

> Use blockquotes for callouts or important notes.

### Code Example

\`\`\`typescript
function hello(name: string) {
  console.log(\`Hello, \${name}!\`);
}
\`\`\`

### Table

| Column A | Column B | Column C |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |
| Data 4   | Data 5   | Data 6   |

## Checklist

- [ ] Task one
- [ ] Task two
- [x] Completed task

---

*Last updated: [date]*`,
    type: "markdown",
  },
]

export function DocumentCreator({ flowId, onDocumentCreated }: DocumentCreatorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [documentTitle, setDocumentTitle] = useState("")
  const [documentContent, setDocumentContent] = useState("")
  const [documentType, setDocumentType] = useState<string>("custom")
  const [showPreview, setShowPreview] = useState(false)

  // Handle template selection
  const handleTemplateSelect = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId)
    if (template) {
      setSelectedTemplate(templateId)
      setDocumentContent(template.content)
      setDocumentType(template.type)
    }
  }

  const isMarkdown = documentType === "markdown" || documentType === "blog" || documentType === "report"

  // Create document
  const createDocument = () => {
    if (!documentTitle.trim()) {
      toast({
        title: "Missing title",
        description: "Please enter a title for your document",
        variant: "destructive",
      })
      return
    }

    const template = selectedTemplate ? templates.find((t) => t.id === selectedTemplate) : null
    const tags = [documentType, ...(template ? [template.type] : []), ...(isMarkdown ? ["markdown"] : [])].filter(
      (v, i, a) => Boolean(v) && a.indexOf(v) === i,
    )

    const node = weaviateService.createNode(
      "document",
      documentTitle.trim(),
      documentContent,
      undefined,
      undefined,
      undefined,
      tags,
      {
        documentType,
        templateId: selectedTemplate,
        flowId,
        isMarkdown,
      },
    )

    weaviateService.trackNodeInteraction(node.id, "create")
    contentProcessingService.enqueueNode(node.id)

    toast({
      title: "Document created",
      description: `"${documentTitle}" has been saved to your knowledge base`,
    })

    onDocumentCreated?.(node.id)
    setIsOpen(false)
    setSelectedTemplate(null)
    setDocumentTitle("")
    setDocumentContent("")
    setDocumentType("custom")
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <FileText className="mr-2 h-4 w-4" />
            Create Document
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[700px]">
          <DialogHeader>
            <DialogTitle>Create Document</DialogTitle>
            <DialogDescription>Create a new document from a template or start from scratch</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className={`border rounded-md p-4 cursor-pointer transition-colors ${
                    selectedTemplate === template.id ? "border-primary bg-primary/10" : "hover:border-primary/50"
                  }`}
                  onClick={() => handleTemplateSelect(template.id)}
                >
                  <h4 className="font-medium">{template.name}</h4>
                  <p className="text-xs text-muted-foreground mt-1">{template.description}</p>
                </div>
              ))}
              <div
                className="border rounded-md p-4 cursor-pointer transition-colors hover:border-primary/50 flex flex-col items-center justify-center"
                onClick={() => {
                  setSelectedTemplate(null)
                  setDocumentContent("")
                }}
              >
                <Plus className="h-8 w-8 text-muted-foreground mb-2" />
                <h4 className="font-medium">Custom</h4>
                <p className="text-xs text-muted-foreground mt-1 text-center">Start from scratch</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="document-title">Document Title</Label>
              <Input
                id="document-title"
                value={documentTitle}
                onChange={(e) => setDocumentTitle(e.target.value)}
                placeholder="Enter document title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="document-type">Document Type</Label>
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select document type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blog">Blog Post</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="report">Report</SelectItem>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="document-content">Content</Label>
                {isMarkdown && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => setShowPreview(!showPreview)}
                  >
                    {showPreview ? <Pen className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showPreview ? "Edit" : "Preview"}
                  </Button>
                )}
              </div>
              {showPreview && isMarkdown ? (
                <div className="border rounded-md p-4 min-h-[240px] max-h-[320px] overflow-y-auto bg-background">
                  <MarkdownRenderer content={documentContent || "*Nothing to preview*"} />
                </div>
              ) : (
                <Textarea
                  id="document-content"
                  value={documentContent}
                  onChange={(e) => setDocumentContent(e.target.value)}
                  placeholder={isMarkdown ? "Write markdown here..." : "Enter document content"}
                  rows={10}
                  className={isMarkdown ? "font-mono text-sm" : ""}
                />
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createDocument}>Create Document</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

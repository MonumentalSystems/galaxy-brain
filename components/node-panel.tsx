"use client"

import type React from "react"

import { useState } from "react"
import {
  Bot,
  BrainCircuit,
  Database,
  FileText,
  Headphones,
  ImageIcon,
  Layers,
  MessageSquare,
  Mic,
  Search,
  SpeakerIcon as SpeakerWave,
  Workflow,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

type NodeType = {
  type: string
  label: string
  icon: React.ReactNode
  category: "ai" | "memory" | "input" | "output" | "processing"
}

const nodeTypes: NodeType[] = [
  {
    type: "aiNode",
    label: "AI Model",
    icon: <Bot className="h-4 w-4" />,
    category: "ai",
  },
  {
    type: "promptNode",
    label: "Prompt",
    icon: <MessageSquare className="h-4 w-4" />,
    category: "input",
  },
  {
    type: "memoryNode",
    label: "Memory",
    icon: <BrainCircuit className="h-4 w-4" />,
    category: "memory",
  },
  {
    type: "knowledgeNode",
    label: "Knowledge",
    icon: <FileText className="h-4 w-4" />,
    category: "memory",
  },
  {
    type: "chainNode",
    label: "Chain",
    icon: <Workflow className="h-4 w-4" />,
    category: "processing",
  },
  {
    type: "outputNode",
    label: "Output",
    icon: <Layers className="h-4 w-4" />,
    category: "output",
  },
  {
    type: "vectorDatabaseNode",
    label: "Vector Database",
    icon: <Database className="h-4 w-4" />,
    category: "memory",
  },
  {
    type: "embeddingNode",
    label: "Embedding",
    icon: <Search className="h-4 w-4" />,
    category: "processing",
  },
  {
    type: "documentParserNode",
    label: "Document Parser",
    icon: <FileText className="h-4 w-4" />,
    category: "input",
  },
  {
    type: "mediaProcessorNode",
    label: "Media Processor",
    icon: <ImageIcon className="h-4 w-4" />,
    category: "processing",
  },
  {
    type: "audioInputNode",
    label: "Audio Input",
    icon: <Mic className="h-4 w-4" />,
    category: "input",
  },
  {
    type: "transcriptionNode",
    label: "Transcription",
    icon: <Headphones className="h-4 w-4" />,
    category: "processing",
  },
  {
    type: "textToSpeechNode",
    label: "Text to Speech",
    icon: <SpeakerWave className="h-4 w-4" />,
    category: "output",
  },
]

type NodePanelProps = {
  onAddNode: (type: string, label: string) => void
}

export function NodePanel({ onAddNode }: NodePanelProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  // Filter nodes based on search query and selected category
  const filteredNodes = nodeTypes.filter((node) => {
    const matchesSearch = node.label.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesCategory = selectedCategory ? node.category === selectedCategory : true
    return matchesSearch && matchesCategory
  })

  // Group nodes by category
  const groupedNodes = filteredNodes.reduce<Record<string, NodeType[]>>((groups, node) => {
    const category = node.category
    if (!groups[category]) {
      groups[category] = []
    }
    groups[category].push(node)
    return groups
  }, {})

  return (
    <div className="w-64 bg-background border rounded-md shadow-sm">
      <div className="p-4">
        <Input
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="mb-2"
        />
        <div className="flex flex-wrap gap-1 mb-2">
          <Button
            variant={selectedCategory === null ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory(null)}
          >
            All
          </Button>
          <Button
            variant={selectedCategory === "ai" ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory("ai")}
          >
            AI
          </Button>
          <Button
            variant={selectedCategory === "input" ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory("input")}
          >
            Input
          </Button>
          <Button
            variant={selectedCategory === "memory" ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory("memory")}
          >
            Memory
          </Button>
          <Button
            variant={selectedCategory === "processing" ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory("processing")}
          >
            Processing
          </Button>
          <Button
            variant={selectedCategory === "output" ? "secondary" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setSelectedCategory("output")}
          >
            Output
          </Button>
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-12rem)]">
        <div className="p-4 pt-0">
          {Object.entries(groupedNodes).map(([category, nodes]) => (
            <div key={category} className="mb-4">
              <h3 className="text-sm font-medium capitalize mb-2">{category}</h3>
              <div className="space-y-1">
                {nodes.map((node) => (
                  <Button
                    key={node.type}
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => onAddNode(node.type, node.label)}
                  >
                    <div className="mr-2">{node.icon}</div>
                    <span className="text-sm">{node.label}</span>
                  </Button>
                ))}
              </div>
              <Separator className="mt-2" />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

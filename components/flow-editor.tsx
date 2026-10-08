"use client"

import { Textarea } from "@/components/ui/textarea"

import type React from "react"

import { useCallback, useEffect, useRef, useState } from "react"
import ReactFlow, {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeTypes,
  Panel,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from "reactflow"
import "reactflow/dist/style.css"

import { ApiKeyManager } from "@/components/api-key-manager"
import { CalendarView } from "@/components/calendar-view"
import { CanvasDrawing } from "@/components/canvas-drawing"
import { CollaborationPanel } from "@/components/collaboration-panel"
import { DocumentCreator } from "@/components/document-creator"
import { DocumentProcessingConfig } from "@/components/document-processing-config"
import { DocumentUpload } from "@/components/document-upload"
import { FlowImport } from "@/components/flow-import"
import { FlowExport } from "@/components/flow-export"
import { FlowSharing } from "@/components/flow-sharing"
import { FlowTaskPlanMigration } from "@/components/flow-task-plan-migration"
import { MediaProcessingConfig } from "@/components/media-processing-config"
import { NodePanel } from "@/components/node-panel"
import { AINode } from "@/components/nodes/ai-node"
import { DocumentParserNode } from "@/components/nodes/document-parser-node"
import { KnowledgeNode } from "@/components/nodes/knowledge-node"
import { MediaProcessorNode } from "@/components/nodes/media-processor-node"
import { MemoryNode } from "@/components/nodes/memory-node"
import { OutputNode } from "@/components/nodes/output-node"
import { PromptNode } from "@/components/nodes/prompt-node"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/use-toast"
import { canvasService } from "@/lib/canvas-service"
import { collaborationService } from "@/lib/collaboration-service"
import { flowService, type Flow } from "@/lib/flow-service"

// Define custom node types
const nodeTypes: NodeTypes = {
  aiNode: AINode,
  promptNode: PromptNode,
  memoryNode: MemoryNode,
  knowledgeNode: KnowledgeNode,
  outputNode: OutputNode,
  documentParserNode: DocumentParserNode,
  mediaProcessorNode: MediaProcessorNode,
}

// Initial nodes for the flow
const initialNodes: Node[] = [
  {
    id: "1",
    type: "promptNode",
    position: { x: 100, y: 100 },
    data: { label: "System Prompt", content: "You are a helpful assistant." },
  },
  {
    id: "2",
    type: "aiNode",
    position: { x: 400, y: 100 },
    data: { label: "GPT-4", model: "gpt-4" },
  },
  {
    id: "3",
    type: "memoryNode",
    position: { x: 250, y: 250 },
    data: { label: "Conversation Memory", type: "buffer" },
  },
  {
    id: "4",
    type: "outputNode",
    position: { x: 700, y: 100 },
    data: { label: "Chat Output" },
  },
]

// Initial edges connecting the nodes
const initialEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2", animated: true },
  { id: "e3-2", source: "3", target: "2", animated: true },
  { id: "e2-4", source: "2", target: "4", animated: true },
]

export function FlowEditor() {
  return (
    <ReactFlowProvider>
      <FlowEditorContent />
    </ReactFlowProvider>
  )
}

function FlowEditorContent() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [currentFlow, setCurrentFlow] = useState<Flow | null>(null)
  const [flowName, setFlowName] = useState("Untitled Flow")
  const [flowDescription, setFlowDescription] = useState("")
  const [isCollaborating, setIsCollaborating] = useState(false)
  const [rightPanel, setRightPanel] = useState<"properties" | "collaboration">("properties")
  const [isDrawingMode, setIsDrawingMode] = useState(false)
  const [viewportDimensions, setViewportDimensions] = useState({ width: 0, height: 0 })
  const [viewportTransform, setViewportTransform] = useState({ x: 0, y: 0, zoom: 1 })
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const reactFlowInstance = useReactFlow()

  // Initialize or load flow
  useEffect(() => {
    // Check if there's a flow ID in the URL
    const urlParams = new URLSearchParams(window.location.search)
    const flowId = urlParams.get("flow")

    if (flowId) {
      // Load existing flow
      const flow = flowService.getFlow(flowId)
      if (flow) {
        setCurrentFlow(flow)
        setFlowName(flow.name)
        setFlowDescription(flow.description)
        setNodes(flow.nodes)
        setEdges(flow.edges)
      } else {
        // Flow not found, create a new one
        createNewFlow()
      }
    } else {
      // No flow ID, create a new one
      createNewFlow()
    }
  }, [])

  // Update viewport dimensions when the window resizes
  useEffect(() => {
    const updateViewportDimensions = () => {
      if (reactFlowWrapper.current) {
        setViewportDimensions({
          width: reactFlowWrapper.current.offsetWidth,
          height: reactFlowWrapper.current.offsetHeight,
        })
      }
    }

    updateViewportDimensions()
    window.addEventListener("resize", updateViewportDimensions)

    return () => {
      window.removeEventListener("resize", updateViewportDimensions)
    }
  }, [])

  // Update viewport transform when the flow changes
  useEffect(() => {
    if (reactFlowInstance) {
      const { x, y, zoom } = reactFlowInstance.getViewport()
      setViewportTransform({ x, y, zoom })
    }
  }, [reactFlowInstance])

  // Create a new flow
  const createNewFlow = () => {
    const newFlow = flowService.createFlow("Untitled Flow", "", initialNodes, initialEdges)
    setCurrentFlow(newFlow)
    setFlowName(newFlow.name)
    setFlowDescription(newFlow.description)
    // Update URL with flow ID
    window.history.replaceState(null, "", `?flow=${newFlow.id}`)
  }

  // Save flow
  const saveFlow = () => {
    if (!currentFlow) return

    const updatedFlow = flowService.updateFlow(
      currentFlow.id,
      {
        name: flowName,
        description: flowDescription,
        nodes,
        edges,
      },
      true, // Increment version
    )

    if (updatedFlow) {
      setCurrentFlow(updatedFlow)
      toast({
        title: "Flow saved",
        description: `"${updatedFlow.name}" has been saved successfully`,
      })
    }
  }

  // Handle node changes (position, selection, etc.)
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updatedNodes = applyNodeChanges(changes, nodes)
      setNodes(updatedNodes)

      // Update selected node if it was changed
      const selectedChange = changes.find((change) => change.type === "select" && (change as any).selected === true)

      if (selectedChange) {
        const node = updatedNodes.find((n) => n.id === (selectedChange as any).id)
        setSelectedNode(node || null)
      } else if (changes.some((change) => change.type === "select" && (change as any).selected === false)) {
        setSelectedNode(null)
      }

      // Update flow in collaboration service
      if (isCollaborating) {
        collaborationService.updateFlow(updatedNodes, edges)
      }
    },
    [nodes, edges, isCollaborating],
  )

  // Handle edge changes
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const updatedEdges = applyEdgeChanges(changes, edges)
      setEdges(updatedEdges)

      // Update flow in collaboration service
      if (isCollaborating) {
        collaborationService.updateFlow(nodes, updatedEdges)
      }
    },
    [nodes, edges, isCollaborating],
  )

  // Handle connecting nodes
  const onConnect = useCallback(
    (connection: Connection) => {
      const updatedEdges = addEdge({ ...connection, animated: true }, edges)
      setEdges(updatedEdges)

      // Update flow in collaboration service
      if (isCollaborating) {
        collaborationService.updateFlow(nodes, updatedEdges)
      }
    },
    [nodes, edges, isCollaborating],
  )

  // Handle node click
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
  }, [])

  // Handle adding a new node
  const onAddNode = useCallback(
    (type: string, label: string) => {
      const newNode: Node = {
        id: `${nodes.length + 1}`,
        type,
        position: {
          x: Math.random() * 300 + 50,
          y: Math.random() * 300 + 50,
        },
        data: { label },
      }

      const updatedNodes = [...nodes, newNode]
      setNodes(updatedNodes)

      // Update flow in collaboration service
      if (isCollaborating) {
        collaborationService.updateFlow(updatedNodes, edges)
      }
    },
    [nodes, edges, isCollaborating],
  )

  // Handle flow import
  const handleFlowImported = (flow: Flow) => {
    setCurrentFlow(flow)
    setFlowName(flow.name)
    setFlowDescription(flow.description)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    // Update URL with flow ID
    window.history.replaceState(null, "", `?flow=${flow.id}`)
  }

  // Handle flow update (e.g., after sharing settings change)
  const handleFlowUpdated = (flow: Flow) => {
    setCurrentFlow(flow)
  }

  // Handle joining collaboration
  const handleJoinCollaboration = async () => {
    if (!currentFlow) return

    try {
      await collaborationService.joinFlow(currentFlow.id)
      setIsCollaborating(true)
      setRightPanel("collaboration")
      toast({
        title: "Joined collaboration",
        description: "You are now collaborating on this flow",
      })
    } catch (error) {
      toast({
        title: "Failed to join collaboration",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      })
    }
  }

  // Handle leaving collaboration
  const handleLeaveCollaboration = () => {
    collaborationService.leaveFlow()
    setIsCollaborating(false)
    setRightPanel("properties")
    toast({
      title: "Left collaboration",
      description: "You are no longer collaborating on this flow",
    })
  }

  // Handle viewport change
  const onViewportChange = useCallback((x: number, y: number, zoom: number) => {
    setViewportTransform({ x, y, zoom })
  }, [])

  // Toggle drawing mode
  const toggleDrawingMode = () => {
    setIsDrawingMode(!isDrawingMode)
    if (!isDrawingMode) {
      // Initialize canvas if not already
      if (currentFlow) {
        canvasService.getCanvasState(currentFlow.id)
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Legacy flow draft</h1>
          <div className="flex items-center gap-2">
            <Input
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              className="h-8 w-64"
              placeholder="Flow name"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ApiKeyManager />
          <CalendarView />
          <DocumentCreator flowId={currentFlow?.id} />
          <FlowImport onFlowImported={handleFlowImported} />
          <FlowExport />
          {currentFlow && <FlowSharing flow={currentFlow} onFlowUpdated={handleFlowUpdated} />}
          <FlowTaskPlanMigration
            flow={{
              id: currentFlow?.id || "unsaved-flow",
              name: flowName,
              description: flowDescription,
              nodes,
              edges,
            }}
          />
          <Button size="sm" onClick={saveFlow}>
            Save local draft
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                More
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56" align="end">
              <div className="space-y-1">
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={toggleDrawingMode}>
                  {isDrawingMode ? "Exit Drawing Mode" : "Enter Drawing Mode"}
                </Button>
                {isCollaborating ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-destructive"
                    onClick={handleLeaveCollaboration}
                  >
                    Leave Collaboration
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleJoinCollaboration}>
                    Collaborate
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div ref={reactFlowWrapper} className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            onMove={(event, viewport) => {
              if (viewport) {
                onViewportChange(viewport.x, viewport.y, viewport.zoom)
              }
            }}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
            <Controls />
            <MiniMap />
            <Panel position="top-left">
              <NodePanel onAddNode={onAddNode} />
            </Panel>
          </ReactFlow>

          {/* Canvas Drawing Layer */}
          {currentFlow && isDrawingMode && (
            <CanvasDrawing
              flowId={currentFlow.id}
              width={viewportDimensions.width}
              height={viewportDimensions.height}
              scale={viewportTransform.zoom}
              translateX={viewportTransform.x}
              translateY={viewportTransform.y}
              isVisible={isDrawingMode}
            />
          )}
        </div>

        <div className="w-80 border-l">
          <Tabs
            value={rightPanel}
            onValueChange={(value) => setRightPanel(value as "properties" | "collaboration")}
          >
            <TabsList className="w-full">
              <TabsTrigger value="properties" className="flex-1">
                Properties
              </TabsTrigger>
              <TabsTrigger value="collaboration" className="flex-1">
                Collaborate
              </TabsTrigger>
            </TabsList>
            <TabsContent value="properties" className="p-4">
              {selectedNode ? (
                <div className="space-y-4">
                  <h3 className="text-lg font-medium">{selectedNode.data.label}</h3>
                  <NodeProperties node={selectedNode} />
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="flow-description">Flow Description</Label>
                    <Textarea
                      id="flow-description"
                      value={flowDescription}
                      onChange={(e) => setFlowDescription(e.target.value)}
                      placeholder="Enter a description for this flow"
                      rows={4}
                    />
                  </div>
                  <div className="text-center text-muted-foreground">Select a node to view its properties</div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="collaboration" className="flex h-[calc(100vh-6rem)] flex-col p-0">
              {currentFlow && <CollaborationPanel flowId={currentFlow.id} />}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

// Update the NodeProperties function to use the new configuration components
function NodeProperties({ node }: { node: Node }) {
  switch (node.type) {
    case "aiNode":
      return (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">Model: {node.data.model || "gpt-4"}</div>
          <div className="text-sm text-muted-foreground">Temperature: 0.7</div>
        </div>
      )
    case "promptNode":
      return (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">Content:</div>
          <div className="rounded-md border p-2 text-sm">{node.data.content || "Enter your prompt here..."}</div>
        </div>
      )
    case "memoryNode":
      return (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">Type: {node.data.type || "buffer"}</div>
          <div className="text-sm text-muted-foreground">Size: 10</div>
        </div>
      )
    case "knowledgeNode":
      return (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">Source: {node.data.source || "None"}</div>
          <div className="text-sm text-muted-foreground">Chunks: 0</div>
        </div>
      )
    case "documentParserNode":
      return (
        <div className="space-y-4">
          <DocumentUpload />
          <DocumentProcessingConfig />
        </div>
      )
    case "mediaProcessorNode":
      return <MediaProcessingConfig />
    default:
      return <div className="text-sm text-muted-foreground">No properties available</div>
  }
}

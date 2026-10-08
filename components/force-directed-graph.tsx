"use client"

import { useEffect, useRef, useState } from "react"
import * as d3 from "d3"
import { Search, ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { type KnowledgeEdge, type KnowledgeNode, weaviateService } from "@/lib/weaviate-service"
import { scopeGraphToWorkspace } from "@/lib/workspace-node-scope"

type ForceGraphProps = {
  /**
   * Root folder of the workspace to scope the graph to, matching how the
   * canvas, field and list views scope themselves. Omit to graph everything.
   */
  workspaceRootFolderId?: string
  onNodeSelect: (node: KnowledgeNode) => void
  width?: number
  height?: number
}

type GraphNode = d3.SimulationNodeDatum & {
  id: string
  label: string
  type: string
  radius: number
  color: string
}

type GraphLink = d3.SimulationLinkDatum<GraphNode> & {
  id: string
  source: string | GraphNode
  target: string | GraphNode
  label?: string
  value: number
}

export function ForceDirectedGraph({ workspaceRootFolderId, onNodeSelect, width, height }: ForceGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const sizeRef = useRef<HTMLDivElement>(null)
  // Measure the container so the simulation centres on what is actually visible.
  // Explicit width/height props still win when a caller needs a fixed size.
  const [measured, setMeasured] = useState({ width: 800, height: 600 })
  const [searchQuery, setSearchQuery] = useState("")
  const [nodes, setNodes] = useState<KnowledgeNode[]>([])
  const [edges, setEdges] = useState<KnowledgeEdge[]>([])
  const [filteredNodes, setFilteredNodes] = useState<KnowledgeNode[]>([])
  const [filteredEdges, setFilteredEdges] = useState<KnowledgeEdge[]>([])

  useEffect(() => {
    const el = sizeRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      if (box.width > 0 && box.height > 0) {
        setMeasured({ width: Math.round(box.width), height: Math.round(box.height) })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const graphWidth = width ?? measured.width
  const graphHeight = height ?? measured.height

  // Load data
  useEffect(() => {
    let allNodes = weaviateService.getNodes()
    let allEdges = weaviateService.getEdges()

    // Scope to the workspace the same way the canvas, field and list views do.
    if (workspaceRootFolderId) {
      const scoped = scopeGraphToWorkspace(allNodes, allEdges, workspaceRootFolderId)
      allNodes = scoped.nodes
      allEdges = scoped.edges
    }

    setNodes(allNodes)
    setEdges(allEdges)
    setFilteredNodes(allNodes)
    setFilteredEdges(allEdges)
  }, [workspaceRootFolderId])

  // Filter nodes and edges based on search query
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredNodes(nodes)
      setFilteredEdges(edges)
      return
    }

    const query = searchQuery.toLowerCase()
    const matchedNodes = nodes.filter(
      (node) =>
        node.title.toLowerCase().includes(query) ||
        node.content.toLowerCase().includes(query) ||
        node.tags.some((tag) => tag.toLowerCase().includes(query)),
    )

    const matchedNodeIds = new Set(matchedNodes.map((node) => node.id))

    // Include nodes that are connected to matched nodes
    const connectedNodes = new Set<string>()
    edges.forEach((edge) => {
      if (matchedNodeIds.has(edge.source)) {
        connectedNodes.add(edge.target)
      }
      if (matchedNodeIds.has(edge.target)) {
        connectedNodes.add(edge.source)
      }
    })

    // Add connected nodes to the filtered set
    connectedNodes.forEach((id) => {
      if (!matchedNodeIds.has(id)) {
        const node = nodes.find((n) => n.id === id)
        if (node) {
          matchedNodes.push(node)
          matchedNodeIds.add(id)
        }
      }
    })

    // Filter edges to only include those between filtered nodes
    const matchedEdges = edges.filter((edge) => matchedNodeIds.has(edge.source) && matchedNodeIds.has(edge.target))

    setFilteredNodes(matchedNodes)
    setFilteredEdges(matchedEdges)
  }, [searchQuery, nodes, edges])

  // Create and update the force-directed graph
  useEffect(() => {
    if (!svgRef.current || filteredNodes.length === 0) return

    // Clear previous graph
    d3.select(svgRef.current).selectAll("*").remove()

    const svg = d3.select(svgRef.current)

    // Create a group for zoom/pan
    const g = svg.append("g")

    // Add zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform)
      })

    svg.call(zoom)

    // Create the graph data
    const graphNodes: GraphNode[] = filteredNodes.map((node) => ({
      id: node.id,
      label: node.title,
      type: node.type,
      radius: node.type === "folder" ? 10 : 6,
      color:
        node.type === "note"
          ? "#3b82f6"
          : node.type === "document"
            ? "#10b981"
            : node.type === "image"
              ? "#f59e0b"
              : node.type === "code"
                ? "#8b5cf6"
                : node.type === "folder"
                  ? "#6b7280"
                  : "#64748b",
    }))

    const graphLinks: GraphLink[] = filteredEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      value: edge.strength || 1,
    }))

    // Create the simulation
    const simulation = d3
      .forceSimulation(graphNodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphLink>(graphLinks)
          .id((d) => d.id)
          .distance((d) => 100 / (d.value || 1)),
      )
      .force("charge", d3.forceManyBody().strength(-100))
      .force("center", d3.forceCenter(graphWidth / 2, graphHeight / 2))
      .force(
        "collide",
        d3.forceCollide().radius((d) => (d as GraphNode).radius * 2),
      )

    // Create the links
    const link = g
      .append("g")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(graphLinks)
      .join("line")
      .attr("stroke-width", (d) => Math.sqrt(d.value))

    // Create the nodes
    const node = g
      .append("g")
      .selectAll("circle")
      .data(graphNodes)
      .join("circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => d.color)
      .call(drag(simulation) as any)
      .on("click", (event, d) => {
        const node = filteredNodes.find((n) => n.id === d.id)
        if (node) {
          onNodeSelect(node)
        }
      })

    // Add node labels
    const label = g
      .append("g")
      .attr("class", "labels")
      .selectAll("text")
      .data(graphNodes)
      .join("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => d.radius + 12)
      .text((d) => d.label)
      .attr("font-size", "8px")
      .attr("fill", "#374151")

    // Update positions on simulation tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x!)
        .attr("y1", (d) => (d.source as GraphNode).y!)
        .attr("x2", (d) => (d.target as GraphNode).x!)
        .attr("y2", (d) => (d.target as GraphNode).y!)

      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!)

      label.attr("x", (d) => d.x!).attr("y", (d) => d.y!)
    })

    // Drag behavior
    function drag(simulation: d3.Simulation<GraphNode, GraphLink>) {
      function dragstarted(event: any) {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        event.subject.fx = event.subject.x
        event.subject.fy = event.subject.y
      }

      function dragged(event: any) {
        event.subject.fx = event.x
        event.subject.fy = event.y
      }

      function dragended(event: any) {
        if (!event.active) simulation.alphaTarget(0)
        event.subject.fx = null
        event.subject.fy = null
      }

      return d3.drag<SVGCircleElement, GraphNode>().on("start", dragstarted).on("drag", dragged).on("end", dragended)
    }

    // Center the graph initially
    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(1))

    return () => {
      simulation.stop()
    }
  }, [filteredNodes, filteredEdges, graphWidth, graphHeight, onNodeSelect])

  // Handle zoom in/out
  const handleZoomIn = () => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3.zoom<SVGSVGElement, unknown>()
    svg.transition().call(zoom.scaleBy, 1.2)
  }

  const handleZoomOut = () => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3.zoom<SVGSVGElement, unknown>()
    svg.transition().call(zoom.scaleBy, 0.8)
  }

  return (
    <div ref={sizeRef} className="relative h-full w-full bg-white dark:bg-gray-950">
      <div className="absolute top-4 left-4 z-10 flex gap-2 items-center">
        <Input
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-64 h-8"
        />
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <div className="absolute top-4 right-4 z-10 flex gap-2">
        <Button variant="outline" size="icon" onClick={handleZoomIn}>
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={handleZoomOut}>
          <ZoomOut className="h-4 w-4" />
        </Button>
      </div>

      <svg ref={svgRef} width={graphWidth} height={graphHeight} className="h-full w-full" />
    </div>
  )
}

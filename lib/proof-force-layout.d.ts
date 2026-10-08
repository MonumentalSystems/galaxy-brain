export type ProofForceLayoutNode = { id: string; layer?: number }
export type ProofForceLayoutEdge = { source: string; target: string }
export type ProofForceLayoutOptions = {
  iterations?: number
  layerGap?: number
  maxForceNodes?: number
  nodeGap?: number
  seed?: number
}

export function proofGraphNodeId(programId: string, packetId: string): string
export function proofCampaignNodeId(programId: string): string

export function forceLayoutProofGraph(
  nodes: ProofForceLayoutNode[],
  edges: ProofForceLayoutEdge[],
  options?: ProofForceLayoutOptions,
): Record<string, { x: number; y: number }>

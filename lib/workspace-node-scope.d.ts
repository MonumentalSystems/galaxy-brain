import type { GalaxyNode } from "./galaxy-brain-service"

export function filterNodesForWorkspace<
  T extends { id: string; parentId?: string | null },
>(
  nodes: T[],
  rootFolderId: string,
): T[]

export function createWorkspaceProjectionCollections<
  T extends Pick<GalaxyNode, "id" | "parentId" | "type" | "updatedAt">,
>(
  nodes: T[],
  rootFolderId: string,
  listTypeFilter: string,
): { fieldNodes: T[]; listNodes: T[] }

export function scopeGraphToWorkspace<
  N extends { id: string; parentId?: string | null },
  E extends { source: string; target: string },
>(
  nodes: N[],
  edges: E[],
  rootFolderId: string,
): { nodes: N[]; edges: E[] }

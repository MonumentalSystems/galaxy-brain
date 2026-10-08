export const GALAXY_OBJECT_KINDS: readonly [
  "paper",
  "document",
  "document.anchor",
  "document.mark",
  "eln.experiment",
  "eln.observation",
  "eln.hypothesis",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "chat",
  "run",
  "turn",
  "claim",
  "artifact",
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
  "proof.graph",
  "proof.node",
]

export type CanonicalGalaxyObjectKind = (typeof GALAXY_OBJECT_KINDS)[number]
export type LegacyGalaxyObjectKind = "legacy.entity" | "legacy.node"
export type GalaxyObjectKind = CanonicalGalaxyObjectKind | LegacyGalaxyObjectKind
export type GalaxyObjectRevisionSelector =
  | { mode: "latest" }
  | { mode: "pinned"; revision: string }

export interface CanonicalGalaxyObjectReference {
  schema: "gb.object-ref.v1"
  format: "canonical"
  kind: CanonicalGalaxyObjectKind
  id: string
  selector: GalaxyObjectRevisionSelector
}

export interface LegacyGalaxyObjectReference {
  schema: "gb.object-ref.v1"
  format: "legacy"
  kind: LegacyGalaxyObjectKind
  id: string
  selector: { mode: "latest" }
}

export type GalaxyObjectReference = CanonicalGalaxyObjectReference | LegacyGalaxyObjectReference

export interface GalaxyObjectResolutionScope {
  tenantId: string
  authorityScope: string
}

export interface GalaxyObjectResolutionRequest {
  reference: GalaxyObjectReference
  scope: GalaxyObjectResolutionScope
  identityKey: string
  kind: GalaxyObjectKind
  id: string
  followLatest: boolean
  revision: string | null
}

export type GalaxyObjectResolver<T = unknown, TContext = unknown> = (
  request: GalaxyObjectResolutionRequest,
  context: TContext,
) => T | Promise<T>

export function createGalaxyObjectReference(
  kind: CanonicalGalaxyObjectKind,
  id: string,
  selector?: GalaxyObjectRevisionSelector,
): string
export function parseGalaxyObjectReference(value: unknown): GalaxyObjectReference | null
export function serializeGalaxyObjectReference(reference: GalaxyObjectReference | unknown): string
export function planGalaxyObjectResolution(
  value: GalaxyObjectReference | string | unknown,
  scope: GalaxyObjectResolutionScope,
): GalaxyObjectResolutionRequest | null
export function selectGalaxyObjectResolver<T = unknown, TContext = unknown>(
  value: GalaxyObjectReference | string | unknown,
  scope: GalaxyObjectResolutionScope,
  resolvers: Partial<Record<GalaxyObjectKind, GalaxyObjectResolver<T, TContext>>>,
): { request: GalaxyObjectResolutionRequest; resolver: GalaxyObjectResolver<T, TContext> } | null

export type FormalProjectArtifactDescriptor = Readonly<{
  format: "json" | "jsonl"
  sha256: string
}>

export type FormalProjectPackage = Readonly<{
  schemaId: "rosetta.formal-project-package.v1"
  projectId: string
  repository: string
  commit: string
  tree: string
  conversionProfile: "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1"
  environment: Readonly<{ leanToolchain: string; mathlibRevision: string }>
  manifestSha256: string
  authoredConceptualDagSha256: string
  repositoryFieldDagSha256: string
  correspondenceSha256: string
  artifacts: Readonly<{
    formalGraph: FormalProjectArtifactDescriptor
    repositoryGraph: FormalProjectArtifactDescriptor
    authoredConceptualDag: FormalProjectArtifactDescriptor
    repositoryFieldDag: FormalProjectArtifactDescriptor
    correspondence: FormalProjectArtifactDescriptor
  }>
  authoredConceptualDag: Readonly<Record<string, unknown>>
  repositoryFieldDag: Readonly<Record<string, unknown>>
  correspondence: Readonly<{
    schemaVersion: "rosetta-authored-formal-correspondence/1.0.0"
    generatedAt: string
    project: string
    revision: string
    visibility: string
    mappingProfile: Readonly<Record<string, unknown>>
    counts: Readonly<Record<string, unknown>>
    nodeMappings: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    edgeCorrespondence: readonly Readonly<Record<string, unknown>>[]
    bridgeNominations: readonly Readonly<Record<string, unknown>>[]
    claimBoundary: Readonly<Record<string, boolean>>
  }>
}>

export function parseFormalProjectPackage(request: Readonly<{
  manifestBytes: Uint8Array
  authoredConceptualDagBytes: Uint8Array
  repositoryFieldDagBytes: Uint8Array
  correspondenceBytes: Uint8Array
}>): Promise<FormalProjectPackage>

export const FORMAL_PROJECT_PACKAGE_LIMITS: Readonly<{
  manifestBytes: number
  artifactBytes: number
  nodeMappings: number
  edgeCorrespondence: number
  bridgeNominations: number
}>

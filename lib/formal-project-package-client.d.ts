import type { FormalProjectArtifactDescriptor } from "./formal-project-package.js"

export interface FormalProjectPackageReview {
  projectId: string
  repository: string
  commit: string
  tree: string
  environment: Readonly<{ leanToolchain: string; mathlibRevision: string }>
  manifestSha256: string
  repositoryFieldDagSha256: string
  repositoryFieldDag: Readonly<{ graph_id: string }>
  artifacts: Readonly<Record<
    "formalGraph" | "repositoryGraph" | "authoredConceptualDag" | "repositoryFieldDag" | "correspondence",
    FormalProjectArtifactDescriptor
  >>
}

export interface FormalProjectPackageSummary {
  schemaId: "gb.formal-project-package.summary.v1"
  registrationId: string
  projectId: string
  repository: string
  commit: string
  tree: string
  environment: Readonly<{ leanToolchain: string; mathlibRevision: string }>
  conversionProfile: "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1"
  manifestSha256: string
  proofGraphRef: Readonly<{ graphId: string; contentSha256: string }>
  artifacts: Readonly<Record<
    "formalGraph" | "repositoryGraph" | "authoredConceptualDag" | "repositoryFieldDag" | "correspondence",
    Readonly<{ materialized: boolean; sha256: string }>
  >>
  registeredByPrincipalId: string
  registeredByNostrPubkey: string
  registeredAt: string
  replayed?: true
}

export function normalizeFormalProjectPackageSummary(
  value: unknown,
  expected: FormalProjectPackageReview,
): FormalProjectPackageSummary

export const FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT: number
export function readFormalProjectPackageResponse(response: Response): Promise<unknown>
export function formalProjectPackageErrorMessage(status: number): string

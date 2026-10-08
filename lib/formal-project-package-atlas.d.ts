import type { FormalProjectPackageSummary } from "./formal-project-package-client.js"

export type FormalProjectPackageAtlasPlacement = Readonly<{
  subjectRef: string
  operationId: string
}>

export function formalProjectPackageAtlasPlacement(
  summary: FormalProjectPackageSummary,
): FormalProjectPackageAtlasPlacement

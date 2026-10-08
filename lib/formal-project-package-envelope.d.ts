export const FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS: Readonly<{
  manifestBytes: number
  artifactBytes: number
  correspondenceBytes: number
  totalBytes: number
}>

export const FORMAL_PROJECT_PACKAGE_MEDIA_TYPE: "application/vnd.galaxy.formal-project-package"

export function encodeFormalProjectPackageEnvelope(input: Readonly<{
  manifestBytes: Uint8Array
  authoredConceptualDagBytes: Uint8Array
  repositoryFieldDagBytes: Uint8Array
  correspondenceBytes: Uint8Array
}>): Uint8Array

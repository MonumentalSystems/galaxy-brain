import { createGalaxyObjectReference } from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u

/**
 * Derive the only Atlas placement created by a formal-project package import.
 * The server-issued registration UUID is the stable placement operation so a
 * replay or retry converges on the same canvas item.
 */
export function formalProjectPackageAtlasPlacement(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || summary.schemaId !== "gb.formal-project-package.summary.v1") {
    throw new TypeError("A strict formal project package summary is required")
  }
  if (typeof summary.registrationId !== "string" || !UUID.test(summary.registrationId)) {
    throw new TypeError("Formal project package registrationId must be a UUID")
  }
  const graphRef = summary.proofGraphRef
  if (!graphRef || typeof graphRef !== "object" || Array.isArray(graphRef)
    || Object.keys(graphRef).sort().join("\n") !== "contentSha256\ngraphId"
    || typeof graphRef.graphId !== "string"
    || typeof graphRef.contentSha256 !== "string"
    || !SHA256.test(graphRef.contentSha256)) {
    throw new TypeError("Formal project package proofGraphRef is invalid")
  }
  return Object.freeze({
    subjectRef: createGalaxyObjectReference("proof.graph", graphRef.graphId, {
      mode: "pinned",
      revision: `sha256:${graphRef.contentSha256}`,
    }),
    operationId: summary.registrationId.toLowerCase(),
  })
}

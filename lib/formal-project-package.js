import { parseProofDag } from "./proof-task-graph.js"

const PACKAGE_SCHEMA = "rosetta.formal-project-package.v1"
const AUTHORED_CONCEPTUAL_DAG_SCHEMA = "rosetta-authored-conceptual-dag/1.0.0"
const CORRESPONDENCE_SCHEMA = "rosetta-authored-formal-correspondence/1.0.0"
const CONVERSION_PROFILE = "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1"
const SHA256 = /^[0-9a-f]{64}$/
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_NODE_MAPPINGS = 10_000
const MAX_EDGE_CORRESPONDENCE = 50_000
const MAX_BRIDGE_NOMINATIONS = 50_000
const MAX_TEXT = 4_000
const MAX_PATH_ITEMS = 2_000
const MAX_COUNT_KEYS = 1_000
const MAX_JSON_DEPTH = 32
const MAX_JSON_MEMBERS = 250_000
const MAX_JSON_STRING = 16_384

const MANIFEST_KEYS = new Set([
  "schemaId", "projectId", "repository", "commit", "tree", "environment",
  "conversionProfile", "artifacts",
])
const ENVIRONMENT_KEYS = new Set(["leanToolchain", "mathlibRevision"])
const ARTIFACT_ROLES = Object.freeze({
  formalGraph: "jsonl",
  repositoryGraph: "json",
  authoredConceptualDag: "json",
  repositoryFieldDag: "json",
  correspondence: "json",
})
const ARTIFACT_KEYS = new Set(["format", "sha256"])
const CORRESPONDENCE_KEYS = new Set([
  "schemaVersion", "generatedAt", "project", "revision", "visibility",
  "mappingProfile", "counts", "nodeMappings", "edgeCorrespondence",
  "bridgeNominations", "claimBoundary",
])
const MAPPING_PROFILE_KEYS = new Set(["rule", "cohortSemantics", "humanMappingsClaimed"])
const COUNTS_KEYS = new Set([
  "formalDeclarations", "formalDependenciesWithinProject", "declarationKinds",
  "dependencyKinds", "dependenciesTargetingInstances", "authoredNodeMappings",
  "authoredEdgeClassifications",
])
const NODE_MAPPING_KEYS = new Set(["status", "rule", "moduleCandidates", "formalDeclarations"])
const EDGE_CORRESPONDENCE_KEYS = new Set([
  "authoredEdge", "prerequisite", "dependent", "status", "supportKind",
  "formalPath", "formalEdgeKinds",
])
const BRIDGE_NOMINATION_KEYS = new Set(["authoredEdge", "reason"])
const CLAIM_BOUNDARY_KEYS = new Set([
  "moduleCohortMappingIsDeclarationEquivalence",
  "unsupportedEdgeIsMathematicallyFalse",
  "formalDependencyImpliesAuthoredInterpretation",
  "shortestPathsRestrictedToExportedLeanProofsDeclarations",
  "projectLocalAxiomPathStatusIsAxiomClosure",
  "externalLeanOrMathlibAxiomsClassified",
  "parallelDependencyPathsClassified",
  "proofTermsOrSourceTextSerialized",
])
const CONCEPTUAL_DAG_KEYS = new Set([
  "schemaVersion", "generatedAt", "project", "revision", "source", "counts",
  "nodes", "edges", "claimBoundary",
])
const CONCEPTUAL_SOURCE_KEYS = new Set(["path", "sha256", "parserProfile"])
const CONCEPTUAL_COUNTS_KEYS = new Set(["nodes", "edges"])
const CONCEPTUAL_NODE_KEYS = new Set(["id", "title", "description", "category", "rawLabel"])
const CONCEPTUAL_EDGE_KEYS = new Set(["id", "source", "target", "semantics"])
const CONCEPTUAL_BOUNDARY_KEYS = new Set([
  "authoredEdgesAreFormalDependencies", "authoredMathematicalClaimsVerified", "layer",
])
const SOURCE_REVISION_KEYS = new Set([
  "repository", "commit", "tree", "lean_toolchain", "mathlib_revision",
])
const FORMAL_MAPPING_STATUSES = new Set([
  "mapped", "unmapped", "ambiguous", "module-without-exported-declarations",
])

// Provider acceptance/publication and operational proof state are separate
// records. They are never valid inside an immutable formal package or its DAG.
const LIFECYCLE_KEYS = new Set([
  "work", "works", "workstate", "workstates", "workstatus", "workstatuses",
  "claim", "claims", "claimid", "claimids", "claimstate", "claimstates",
  "claimstatus", "claimstatuses", "run", "runs", "runid", "runids", "runstate",
  "runstates", "runstatus", "runstatuses", "frontier", "frontiers",
  "frontierstate", "frontierstates", "frontierstatus", "frontierstatuses",
  "mission", "missions", "missionid", "missionids", "missionstate", "missionstates",
  "missionstatus", "missionstatuses", "campaign", "campaigns", "workspace",
  "workspaces", "workspaceid", "workspaceids", "workspacekey", "workspacekeys",
  "verification", "verifications", "verificationstatus", "verificationstatuses",
  "proofstatus", "proofstatuses", "provider", "providers", "providerstatus",
  "providerstatuses", "external", "prove2me", "prove2mestatus",
  "prove2meaccepted", "rosetta", "rosettastatus", "rosettapublished",
  "hyades", "hyadesrun", "hyadesstatus", "live", "livestate", "livestatus",
])

function invalid(message) {
  throw new Error(message)
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(object(value, label))
  const unknown = keys.find((key) => !allowed.has(key))
  if (unknown) invalid(`${label} contains unsupported field ${unknown}`)
  const missing = [...allowed].find((key) => !Object.hasOwn(value, key))
  if (missing) invalid(`${label}.${missing} is required`)
  return value
}

function text(value, label, maximum = MAX_TEXT) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    invalid(`${label} must be canonical non-empty text`)
  }
  if (value.length > maximum) invalid(`${label} exceeds ${maximum} characters`)
  return value
}

function identifier(value, label) {
  if (typeof value !== "string" || !NODE_ID.test(value)) invalid(`${label} is invalid`)
  return value
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative integer`)
  return value
}

function gitOid(value, label) {
  if (typeof value !== "string" || !GIT_OID.test(value)) invalid(`${label} must be a lowercase Git object ID`)
  return value
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function stringArray(value, label, maximum = MAX_PATH_ITEMS) {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(`${label} must contain at most ${maximum} entries`)
  }
  return value.map((item, index) => text(item, `${label}[${index}]`))
}

function normalizeLifecycleKey(key) {
  return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase()
}

function rejectLifecycleFields(value, path, correspondence = false, parentKey = "") {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeLifecycleKey(key)
    if (LIFECYCLE_KEYS.has(normalized)) {
      invalid(`${path}.${key} is provider or proof lifecycle state and is not permitted`)
    }
    if (
      normalized === "status"
      && !correspondence
      && !new Set(["formalbinding", "formalcorrespondence"]).has(normalizeLifecycleKey(parentKey))
    ) {
      invalid(`${path}.${key} is live status state and is not permitted`)
    }
    rejectLifecycleFields(child, `${path}.${key}`, correspondence, key)
  }
}

function boundedJsonStructure(value, label) {
  let members = 0
  const pending = [[value, 0]]
  while (pending.length) {
    const [current, depth] = pending.pop()
    if (depth > MAX_JSON_DEPTH) invalid(`${label} exceeds the JSON depth bound`)
    if (current && typeof current === "object") {
      const entries = Array.isArray(current) ? current.entries() : Object.entries(current)
      const children = [...entries]
      members += children.length
      for (const [key, child] of children) {
        if (!Array.isArray(current)) text(key, `${label} field name`, MAX_JSON_STRING)
        pending.push([child, depth + 1])
      }
    } else if (typeof current === "string") {
      if (current.length > MAX_JSON_STRING) invalid(`${label} text exceeds ${MAX_JSON_STRING} characters`)
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      invalid(`${label} contains a non-finite JSON number`)
    }
    if (members > MAX_JSON_MEMBERS) invalid(`${label} exceeds the JSON member bound`)
  }
}

function scanString(source, start) {
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2
      continue
    }
    if (source[cursor] === "\"") return cursor + 1
    cursor += 1
  }
  invalid("JSON string is unterminated")
}

function rejectDuplicateJsonKeys(source, label) {
  let cursor = 0
  const whitespace = () => {
    while (/\s/u.test(source[cursor] || "")) cursor += 1
  }
  const expect = (character) => {
    whitespace()
    if (source[cursor] !== character) invalid(`${label} is invalid JSON`)
    cursor += 1
  }
  const value = () => {
    whitespace()
    const first = source[cursor]
    if (first === "{") {
      cursor += 1
      whitespace()
      const keys = new Set()
      if (source[cursor] === "}") {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        whitespace()
        if (source[cursor] !== "\"") invalid(`${label} is invalid JSON`)
        const end = scanString(source, cursor)
        const key = JSON.parse(source.slice(cursor, end))
        if (keys.has(key)) invalid(`${label} contains duplicate JSON key ${key}`)
        keys.add(key)
        cursor = end
        expect(":")
        value()
        whitespace()
        if (source[cursor] === "}") {
          cursor += 1
          return
        }
        expect(",")
      }
      invalid(`${label} is invalid JSON`)
    }
    if (first === "[") {
      cursor += 1
      whitespace()
      if (source[cursor] === "]") {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        value()
        whitespace()
        if (source[cursor] === "]") {
          cursor += 1
          return
        }
        expect(",")
      }
      invalid(`${label} is invalid JSON`)
    }
    if (first === "\"") {
      cursor = scanString(source, cursor)
      return
    }
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1
  }
  value()
  whitespace()
  if (cursor !== source.length) invalid(`${label} is invalid JSON`)
}

function exactBytes(value, label, maximum) {
  if (!(value instanceof Uint8Array)) invalid(`${label} must be exact UTF-8 bytes`)
  if (value.byteLength === 0 || value.byteLength > maximum) {
    invalid(`${label} must contain 1 to ${maximum} bytes`)
  }
  return new Uint8Array(value)
}

function parseJsonBytes(bytes, label) {
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    invalid(`${label} must be valid UTF-8`)
  }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    invalid(`${label} must be valid JSON`)
  }
  rejectDuplicateJsonKeys(source, label)
  return parsed
}

async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(result)].map((item) => item.toString(16).padStart(2, "0")).join("")
}

function parseDescriptor(value, role) {
  exactKeys(value, ARTIFACT_KEYS, `Manifest artifacts.${role}`)
  if (value.format !== ARTIFACT_ROLES[role]) {
    invalid(`Manifest artifacts.${role}.format must be ${ARTIFACT_ROLES[role]}`)
  }
  return { format: value.format, sha256: sha256(value.sha256, `Manifest artifacts.${role}.sha256`) }
}

function parseManifest(value) {
  exactKeys(value, MANIFEST_KEYS, "Manifest")
  if (value.schemaId !== PACKAGE_SCHEMA) invalid(`Manifest must use ${PACKAGE_SCHEMA}`)
  if (value.conversionProfile !== CONVERSION_PROFILE) {
    invalid(`Manifest conversionProfile must be ${CONVERSION_PROFILE}`)
  }
  const environment = exactKeys(value.environment, ENVIRONMENT_KEYS, "Manifest environment")
  const artifacts = exactKeys(
    value.artifacts,
    new Set(Object.keys(ARTIFACT_ROLES)),
    "Manifest artifacts",
  )
  return {
    schemaId: value.schemaId,
    projectId: typeof value.projectId === "string" && PROJECT_ID.test(value.projectId)
      ? value.projectId
      : invalid("Manifest projectId is invalid"),
    repository: text(value.repository, "Manifest repository", 500),
    commit: gitOid(value.commit, "Manifest commit"),
    tree: gitOid(value.tree, "Manifest tree"),
    conversionProfile: value.conversionProfile,
    environment: {
      leanToolchain: text(environment.leanToolchain, "Manifest environment.leanToolchain", 200),
      mathlibRevision: gitOid(environment.mathlibRevision, "Manifest environment.mathlibRevision"),
    },
    artifacts: Object.fromEntries(
      Object.keys(ARTIFACT_ROLES).map((role) => [role, parseDescriptor(artifacts[role], role)]),
    ),
  }
}

function countMap(value, label) {
  const entries = Object.entries(object(value, label))
  if (entries.length > MAX_COUNT_KEYS) invalid(`${label} exceeds ${MAX_COUNT_KEYS} entries`)
  return Object.fromEntries(entries.map(([key, count]) => [
    text(key, `${label} key`, 200),
    nonnegativeInteger(count, `${label}.${key}`),
  ]))
}

function parseCounts(value) {
  exactKeys(value, COUNTS_KEYS, "Correspondence counts")
  return {
    formalDeclarations: nonnegativeInteger(value.formalDeclarations, "Correspondence counts.formalDeclarations"),
    formalDependenciesWithinProject: nonnegativeInteger(value.formalDependenciesWithinProject, "Correspondence counts.formalDependenciesWithinProject"),
    declarationKinds: countMap(value.declarationKinds, "Correspondence counts.declarationKinds"),
    dependencyKinds: countMap(value.dependencyKinds, "Correspondence counts.dependencyKinds"),
    dependenciesTargetingInstances: nonnegativeInteger(value.dependenciesTargetingInstances, "Correspondence counts.dependenciesTargetingInstances"),
    authoredNodeMappings: countMap(value.authoredNodeMappings, "Correspondence counts.authoredNodeMappings"),
    authoredEdgeClassifications: countMap(value.authoredEdgeClassifications, "Correspondence counts.authoredEdgeClassifications"),
  }
}

function optionalText(value, label, maximum = MAX_TEXT) {
  if (typeof value !== "string" || value !== value.trim()) {
    invalid(`${label} must be canonical text`)
  }
  if (value.length > maximum) invalid(`${label} exceeds ${maximum} characters`)
  return value
}

function parseAuthoredConceptualDag(value, manifest) {
  exactKeys(value, CONCEPTUAL_DAG_KEYS, "Authored conceptual DAG")
  if (value.schemaVersion !== AUTHORED_CONCEPTUAL_DAG_SCHEMA) {
    invalid(`Authored conceptual DAG must use ${AUTHORED_CONCEPTUAL_DAG_SCHEMA}`)
  }
  if (value.project !== manifest.projectId) {
    invalid("Authored conceptual DAG project must match manifest projectId")
  }
  if (value.revision !== manifest.commit) {
    invalid("Authored conceptual DAG revision must match manifest commit")
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    invalid("Authored conceptual DAG generatedAt must be an ISO timestamp")
  }
  const source = exactKeys(value.source, CONCEPTUAL_SOURCE_KEYS, "Authored conceptual DAG source")
  const counts = exactKeys(value.counts, CONCEPTUAL_COUNTS_KEYS, "Authored conceptual DAG counts")
  const nodeCount = nonnegativeInteger(counts.nodes, "Authored conceptual DAG counts.nodes")
  const edgeCount = nonnegativeInteger(counts.edges, "Authored conceptual DAG counts.edges")
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > MAX_NODE_MAPPINGS) {
    invalid(`Authored conceptual DAG nodes must contain 1 to ${MAX_NODE_MAPPINGS} entries`)
  }
  if (!Array.isArray(value.edges) || value.edges.length > MAX_EDGE_CORRESPONDENCE) {
    invalid(`Authored conceptual DAG edges must contain at most ${MAX_EDGE_CORRESPONDENCE} entries`)
  }
  if (nodeCount !== value.nodes.length || edgeCount !== value.edges.length) {
    invalid("Authored conceptual DAG counts must match its node and edge arrays")
  }
  const nodeIds = new Set()
  const nodes = value.nodes.map((raw, index) => {
    const label = `Authored conceptual DAG nodes[${index}]`
    exactKeys(raw, CONCEPTUAL_NODE_KEYS, label)
    const id = identifier(raw.id, `${label}.id`)
    if (nodeIds.has(id)) invalid(`Authored conceptual DAG node ${id} is duplicated`)
    nodeIds.add(id)
    return {
      id,
      title: text(raw.title, `${label}.title`, 500),
      description: optionalText(raw.description, `${label}.description`),
      category: text(raw.category, `${label}.category`, 120),
      rawLabel: text(raw.rawLabel, `${label}.rawLabel`, MAX_TEXT),
    }
  })
  const edgeIds = new Set()
  const edges = value.edges.map((raw, index) => {
    const label = `Authored conceptual DAG edges[${index}]`
    exactKeys(raw, CONCEPTUAL_EDGE_KEYS, label)
    const id = text(raw.id, `${label}.id`, 512)
    if (edgeIds.has(id)) invalid(`Authored conceptual DAG edge ${id} is duplicated`)
    edgeIds.add(id)
    const sourceId = identifier(raw.source, `${label}.source`)
    const targetId = identifier(raw.target, `${label}.target`)
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
      invalid(`Authored conceptual DAG edge ${id} references a missing node`)
    }
    if (sourceId === targetId) invalid(`Authored conceptual DAG edge ${id} cannot be self-referential`)
    if (raw.semantics !== "authored-prerequisite-to-dependent") {
      invalid(`${label}.semantics must be authored-prerequisite-to-dependent`)
    }
    return { id, source: sourceId, target: targetId, semantics: raw.semantics }
  })
  const boundary = exactKeys(
    value.claimBoundary,
    CONCEPTUAL_BOUNDARY_KEYS,
    "Authored conceptual DAG claimBoundary",
  )
  if (boundary.authoredEdgesAreFormalDependencies !== false) {
    invalid("Authored conceptual DAG cannot claim authored edges are formal dependencies")
  }
  if (boundary.authoredMathematicalClaimsVerified !== false) {
    invalid("Authored conceptual DAG cannot claim authored mathematical claims are verified")
  }
  if (boundary.layer !== "hypothesis-and-interpretation") {
    invalid("Authored conceptual DAG claimBoundary.layer is invalid")
  }
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    project: value.project,
    revision: value.revision,
    source: {
      path: text(source.path, "Authored conceptual DAG source.path", 1_000),
      sha256: sha256(source.sha256, "Authored conceptual DAG source.sha256"),
      parserProfile: text(source.parserProfile, "Authored conceptual DAG source.parserProfile", 500),
    },
    counts: { nodes: nodeCount, edges: edgeCount },
    nodes,
    edges,
    claimBoundary: {
      authoredEdgesAreFormalDependencies: false,
      authoredMathematicalClaimsVerified: false,
      layer: boundary.layer,
    },
  }
}

function parseCorrespondence(value, manifest, authoredConceptualDag) {
  exactKeys(value, CORRESPONDENCE_KEYS, "Correspondence")
  if (value.schemaVersion !== CORRESPONDENCE_SCHEMA) {
    invalid(`Correspondence must use ${CORRESPONDENCE_SCHEMA}`)
  }
  if (value.project !== manifest.projectId) invalid("Correspondence project must match manifest projectId")
  if (value.revision !== manifest.commit) invalid("Correspondence revision must match manifest commit")
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    invalid("Correspondence generatedAt must be an ISO timestamp")
  }
  const profile = exactKeys(value.mappingProfile, MAPPING_PROFILE_KEYS, "Correspondence mappingProfile")
  if (typeof profile.humanMappingsClaimed !== "boolean") {
    invalid("Correspondence mappingProfile.humanMappingsClaimed must be boolean")
  }
  const mappingEntries = Object.entries(object(value.nodeMappings, "Correspondence nodeMappings"))
  if (mappingEntries.length > MAX_NODE_MAPPINGS) {
    invalid(`Correspondence nodeMappings exceeds ${MAX_NODE_MAPPINGS} entries`)
  }
  const nodeMappings = {}
  for (const [nodeId, raw] of mappingEntries) {
    identifier(nodeId, "Correspondence nodeMappings key")
    exactKeys(raw, NODE_MAPPING_KEYS, `Correspondence nodeMappings.${nodeId}`)
    const status = text(raw.status, `Correspondence nodeMappings.${nodeId}.status`, 120)
    if (!FORMAL_MAPPING_STATUSES.has(status)) {
      invalid(`Correspondence nodeMappings.${nodeId}.status is not a formal mapping classification`)
    }
    nodeMappings[nodeId] = {
      status,
      rule: text(raw.rule, `Correspondence nodeMappings.${nodeId}.rule`, 500),
      moduleCandidates: stringArray(raw.moduleCandidates, `Correspondence nodeMappings.${nodeId}.moduleCandidates`),
      formalDeclarations: stringArray(raw.formalDeclarations, `Correspondence nodeMappings.${nodeId}.formalDeclarations`),
    }
  }
  const targetIds = new Set(authoredConceptualDag.nodes.map((node) => node.id))
  const mappingIds = new Set(Object.keys(nodeMappings))
  if (
    targetIds.size !== mappingIds.size
    || [...targetIds].some((targetId) => !mappingIds.has(targetId))
  ) {
    invalid("Correspondence nodeMappings must exactly match the authored DAG target IDs")
  }
  if (!Array.isArray(value.edgeCorrespondence) || value.edgeCorrespondence.length > MAX_EDGE_CORRESPONDENCE) {
    invalid(`Correspondence edgeCorrespondence must contain at most ${MAX_EDGE_CORRESPONDENCE} entries`)
  }
  const relationById = new Map(authoredConceptualDag.edges.map((edge) => [edge.id, edge]))
  const seenEdges = new Set()
  const edgeCorrespondence = value.edgeCorrespondence.map((raw, index) => {
    const label = `Correspondence edgeCorrespondence[${index}]`
    exactKeys(raw, EDGE_CORRESPONDENCE_KEYS, label)
    const formalPath = raw.formalPath === null ? null : stringArray(raw.formalPath, `${label}.formalPath`)
    if (!Array.isArray(raw.formalEdgeKinds) || raw.formalEdgeKinds.length > MAX_PATH_ITEMS) {
      invalid(`${label}.formalEdgeKinds must contain at most ${MAX_PATH_ITEMS} entries`)
    }
    const authoredEdge = text(raw.authoredEdge, `${label}.authoredEdge`, 512)
    if (seenEdges.has(authoredEdge)) invalid(`Correspondence edge ${authoredEdge} is duplicated`)
    seenEdges.add(authoredEdge)
    const relation = relationById.get(authoredEdge)
    if (!relation) invalid(`Correspondence edge ${authoredEdge} is not in the authored DAG`)
    const prerequisite = identifier(raw.prerequisite, `${label}.prerequisite`)
    const dependent = identifier(raw.dependent, `${label}.dependent`)
    if (
      prerequisite !== relation.source
      || dependent !== relation.target
    ) {
      invalid(`Correspondence edge ${authoredEdge} endpoints do not match the authored DAG`)
    }
    return {
      authoredEdge,
      prerequisite,
      dependent,
      status: text(raw.status, `${label}.status`, 120),
      supportKind: raw.supportKind === null ? null : text(raw.supportKind, `${label}.supportKind`, 120),
      formalPath,
      formalEdgeKinds: raw.formalEdgeKinds.map((item, step) => (
        stringArray(item, `${label}.formalEdgeKinds[${step}]`, 100)
      )),
    }
  })
  if (
    relationById.size !== seenEdges.size
    || [...relationById.keys()].some((relationId) => !seenEdges.has(relationId))
  ) {
    invalid("Correspondence edgeCorrespondence must exactly match the authored DAG relation IDs")
  }
  if (!Array.isArray(value.bridgeNominations) || value.bridgeNominations.length > MAX_BRIDGE_NOMINATIONS) {
    invalid(`Correspondence bridgeNominations must contain at most ${MAX_BRIDGE_NOMINATIONS} entries`)
  }
  const seenNominations = new Set()
  const bridgeNominations = value.bridgeNominations.map((raw, index) => {
    const label = `Correspondence bridgeNominations[${index}]`
    exactKeys(raw, BRIDGE_NOMINATION_KEYS, label)
    const authoredEdge = text(raw.authoredEdge, `${label}.authoredEdge`, 512)
    if (!relationById.has(authoredEdge)) invalid(`Bridge nomination ${authoredEdge} is not in the authored DAG`)
    if (seenNominations.has(authoredEdge)) invalid(`Bridge nomination ${authoredEdge} is duplicated`)
    seenNominations.add(authoredEdge)
    return {
      authoredEdge,
      reason: text(raw.reason, `${label}.reason`, 500),
    }
  })
  const boundary = exactKeys(value.claimBoundary, CLAIM_BOUNDARY_KEYS, "Correspondence claimBoundary")
  for (const key of CLAIM_BOUNDARY_KEYS) {
    if (typeof boundary[key] !== "boolean") invalid(`Correspondence claimBoundary.${key} must be boolean`)
  }
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    project: value.project,
    revision: value.revision,
    visibility: text(value.visibility, "Correspondence visibility", 80),
    mappingProfile: {
      rule: text(profile.rule, "Correspondence mappingProfile.rule", 500),
      cohortSemantics: text(profile.cohortSemantics, "Correspondence mappingProfile.cohortSemantics"),
      humanMappingsClaimed: profile.humanMappingsClaimed,
    },
    counts: parseCounts(value.counts),
    nodeMappings,
    edgeCorrespondence,
    bridgeNominations,
    claimBoundary: Object.fromEntries([...CLAIM_BOUNDARY_KEYS].map((key) => [key, boundary[key]])),
  }
}

function validateFormalBindingClassifications(repositoryFieldDag, correspondence) {
  for (const target of repositoryFieldDag.targets) {
    if (target.formal_binding === undefined) continue
    const binding = object(target.formal_binding, `Target ${target.target_id} formal_binding`)
    if (binding.status === undefined) continue
    const status = text(binding.status, `Target ${target.target_id} formal_binding.status`, 120)
    if (!FORMAL_MAPPING_STATUSES.has(status)) {
      invalid(`Target ${target.target_id} formal_binding.status is not a formal mapping classification`)
    }
    const expected = correspondence.nodeMappings[target.target_id].status
    if (status !== expected) {
      invalid(`Target ${target.target_id} formal_binding.status does not match correspondence classification`)
    }
  }
}

function validateRepositoryFieldDag(value, manifest, contentSha256, authoredConceptualDag) {
  object(value, "Repository-field DAG")
  rejectLifecycleFields(value, "Repository-field DAG")
  if (value.graph_kind !== "repository-field") {
    invalid("Repository-field DAG must be passive")
  }
  const revision = exactKeys(
    value.source_revision,
    SOURCE_REVISION_KEYS,
    "Repository-field DAG source_revision",
  )
  const expected = {
    repository: manifest.repository,
    commit: manifest.commit,
    tree: manifest.tree,
    lean_toolchain: manifest.environment.leanToolchain,
    mathlib_revision: manifest.environment.mathlibRevision,
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (revision[key] !== expectedValue) {
      invalid(`Repository-field DAG source_revision.${key} must match the package manifest`)
    }
  }
  const rawNodeIds = new Set(authoredConceptualDag.nodes.map((node) => node.id))
  const projectedNodeIds = new Set(value.targets.map((target) => target.target_id))
  if (
    rawNodeIds.size !== projectedNodeIds.size
    || [...rawNodeIds].some((nodeId) => !projectedNodeIds.has(nodeId))
  ) {
    invalid("Repository-field DAG targets must exactly match authored conceptual DAG node IDs")
  }
  const rawEdgeById = new Map(authoredConceptualDag.edges.map((edge) => [edge.id, edge]))
  const projectedEdgeIds = new Set()
  for (const relation of value.relations) {
    if (projectedEdgeIds.has(relation.relation_id)) {
      invalid(`Repository-field DAG relation ${relation.relation_id} is duplicated`)
    }
    projectedEdgeIds.add(relation.relation_id)
    const raw = rawEdgeById.get(relation.relation_id)
    if (!raw) invalid(`Repository-field DAG relation ${relation.relation_id} is not in the authored conceptual DAG`)
    if (
      relation.relation_type !== "AUTHORED_PREREQUISITE"
      || relation.prerequisite_target_id !== raw.source
      || relation.dependent_target_id !== raw.target
    ) {
      invalid(`Repository-field DAG relation ${relation.relation_id} does not match the authored conceptual edge`)
    }
  }
  if (
    rawEdgeById.size !== projectedEdgeIds.size
    || [...rawEdgeById.keys()].some((edgeId) => !projectedEdgeIds.has(edgeId))
  ) {
    invalid("Repository-field DAG relations must exactly match authored conceptual DAG edge IDs")
  }
  parseProofDag(value, contentSha256)
  return structuredClone(value)
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

/**
 * Verify and normalize a Rosetta formal-project package without performing I/O.
 * The producer-authored conceptual DAG stays byte-distinct from its passive
 * Galaxy repository-field projection. Formal and repository graph descriptors
 * remain immutable external refs in this slice.
 */
export async function parseFormalProjectPackage(request) {
  exactKeys(
    request,
    new Set([
      "manifestBytes", "authoredConceptualDagBytes", "repositoryFieldDagBytes",
      "correspondenceBytes",
    ]),
    "Formal project package request",
  )
  // Snapshot before the first await so a caller cannot mutate bytes in flight.
  const manifestBytes = exactBytes(request.manifestBytes, "manifestBytes", MAX_MANIFEST_BYTES)
  const authoredConceptualDagBytes = exactBytes(
    request.authoredConceptualDagBytes,
    "authoredConceptualDagBytes",
    MAX_ARTIFACT_BYTES,
  )
  const repositoryFieldDagBytes = exactBytes(
    request.repositoryFieldDagBytes,
    "repositoryFieldDagBytes",
    MAX_ARTIFACT_BYTES,
  )
  const correspondenceBytes = exactBytes(request.correspondenceBytes, "correspondenceBytes", MAX_ARTIFACT_BYTES)

  const manifest = parseManifest(parseJsonBytes(manifestBytes, "Manifest"))
  boundedJsonStructure(manifest, "Manifest")
  rejectLifecycleFields(manifest, "Manifest")
  const authoredConceptualDagValue = parseJsonBytes(
    authoredConceptualDagBytes,
    "Authored conceptual DAG",
  )
  const repositoryFieldDagValue = parseJsonBytes(repositoryFieldDagBytes, "Repository-field DAG")
  const correspondenceValue = parseJsonBytes(correspondenceBytes, "Correspondence")
  boundedJsonStructure(authoredConceptualDagValue, "Authored conceptual DAG")
  boundedJsonStructure(repositoryFieldDagValue, "Repository-field DAG")
  boundedJsonStructure(correspondenceValue, "Correspondence")
  rejectLifecycleFields(correspondenceValue, "Correspondence", true)

  const [
    manifestSha256,
    authoredConceptualDagSha256,
    repositoryFieldDagSha256,
    correspondenceSha256,
  ] = await Promise.all([
    digest(manifestBytes),
    digest(authoredConceptualDagBytes),
    digest(repositoryFieldDagBytes),
    digest(correspondenceBytes),
  ])
  if (authoredConceptualDagSha256 !== manifest.artifacts.authoredConceptualDag.sha256) {
    invalid("Authored conceptual DAG SHA-256 does not match the package manifest")
  }
  if (repositoryFieldDagSha256 !== manifest.artifacts.repositoryFieldDag.sha256) {
    invalid("Repository-field DAG SHA-256 does not match the package manifest")
  }
  if (correspondenceSha256 !== manifest.artifacts.correspondence.sha256) {
    invalid("Correspondence SHA-256 does not match the package manifest")
  }

  const authoredConceptualDag = parseAuthoredConceptualDag(authoredConceptualDagValue, manifest)
  const repositoryFieldDag = validateRepositoryFieldDag(
    repositoryFieldDagValue,
    manifest,
    repositoryFieldDagSha256,
    authoredConceptualDag,
  )
  const correspondence = parseCorrespondence(
    correspondenceValue,
    manifest,
    authoredConceptualDag,
  )
  validateFormalBindingClassifications(repositoryFieldDag, correspondence)
  return deepFreeze({
    ...manifest,
    manifestSha256,
    authoredConceptualDagSha256,
    repositoryFieldDagSha256,
    correspondenceSha256,
    authoredConceptualDag,
    repositoryFieldDag,
    correspondence,
  })
}

export const FORMAL_PROJECT_PACKAGE_LIMITS = Object.freeze({
  manifestBytes: MAX_MANIFEST_BYTES,
  artifactBytes: MAX_ARTIFACT_BYTES,
  nodeMappings: MAX_NODE_MAPPINGS,
  edgeCorrespondence: MAX_EDGE_CORRESPONDENCE,
  bridgeNominations: MAX_BRIDGE_NOMINATIONS,
})

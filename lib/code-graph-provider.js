const MAX_IDENTIFIER_CHARACTERS = 512
const MAX_PATH_CHARACTERS = 2_048
const MAX_AUTHORITY_CHARACTERS = 1_024
const MAX_LABEL_CHARACTERS = 512
const MAX_LANGUAGE_CHARACTERS = 64
const MAX_PROVIDER_CHARACTERS = 128
const MAX_SOURCE_NODES = 100_000
const MAX_SOURCE_EDGES = 500_000
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const SNAPSHOT_PATTERN = /^sha256:[a-f0-9]{64}$/u

export const CODE_GRAPH_MAX_DEPTH = 4
export const CODE_GRAPH_MAX_NODES = 250
export const CODE_GRAPH_MAX_EDGES = 2_000

const NODE_KINDS = new Set(["repository", "file", "symbol"])
const EDGE_TYPES = new Set([
  "contains",
  "defines",
  "imports",
  "calls",
  "references",
  "extends",
  "implements",
  "depends_on",
])
const GALAXY_CODE_KINDS = new Set([
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
])

function invalid(message) {
  throw new Error(`Invalid code graph contract: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(value, name, maximum, pattern) {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    invalid(`${name} must be a non-empty, unpadded string`)
  }
  if (Array.from(value).length > maximum || CONTROL_CHARACTERS.test(value)) {
    invalid(`${name} is outside its safe character bounds`)
  }
  if (pattern && !pattern.test(value)) invalid(`${name} has an invalid format`)
  return value
}

function optionalBoundedString(value, name, maximum) {
  return value === undefined ? undefined : boundedString(value, name, maximum)
}

function exactRecord(value, name, allowed) {
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) {
    invalid(`${name} must contain only supported fields`)
  }
  return value
}

function normalizeRepositoryId(value) {
  return boundedString(value, "repositoryId", MAX_IDENTIFIER_CHARACTERS)
}

function normalizePath(value) {
  const path = boundedString(value, "path", MAX_PATH_CHARACTERS)
  if (path.startsWith("/") || path.includes("\\")) {
    invalid("path must be a repository-relative POSIX path")
  }
  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalid("path must not contain empty, dot, or parent segments")
  }
  return path
}

function normalizeSymbol(value) {
  return boundedString(value, "symbol", MAX_IDENTIFIER_CHARACTERS)
}

function decodeSegment(value, name) {
  try {
    const decoded = decodeURIComponent(value)
    if (encodeURIComponent(decoded) !== value) invalid(`${name} must use canonical percent encoding`)
    return decoded
  } catch {
    invalid(`${name} contains malformed percent encoding`)
  }
}

function normalizeCodeGraphRef(value) {
  const ref = exactRecord(value, "reference", new Set(["kind", "repositoryId", "path", "symbol"]))
  const kind = boundedString(ref.kind, "reference kind", 32)
  const repositoryId = normalizeRepositoryId(ref.repositoryId)

  if (kind === "repository") {
    if (ref.path !== undefined || ref.symbol !== undefined) invalid("repository references cannot carry path or symbol")
    return Object.freeze({ kind, repositoryId })
  }
  if (kind === "file") {
    if (ref.symbol !== undefined) invalid("file references cannot carry a symbol")
    return Object.freeze({ kind, repositoryId, path: normalizePath(ref.path) })
  }
  if (kind === "symbol") {
    return Object.freeze({
      kind,
      repositoryId,
      path: normalizePath(ref.path),
      symbol: normalizeSymbol(ref.symbol),
    })
  }
  invalid("reference kind must be repository, file, or symbol")
}

function normalizeScope(value) {
  const scope = exactRecord(value, "scope", new Set(["tenantId", "authorityScope", "repository"]))
  const repository = exactRecord(
    scope.repository,
    "scope repository",
    new Set(["repositoryId", "commit", "snapshotDigest"]),
  )
  return Object.freeze({
    tenantId: boundedString(scope.tenantId, "tenantId", MAX_IDENTIFIER_CHARACTERS),
    authorityScope: boundedString(scope.authorityScope, "authorityScope", MAX_AUTHORITY_CHARACTERS),
    repository: Object.freeze({
      repositoryId: normalizeRepositoryId(repository.repositoryId),
      commit: boundedString(repository.commit, "commit", 64, COMMIT_PATTERN),
      snapshotDigest: boundedString(repository.snapshotDigest, "snapshotDigest", 71, SNAPSHOT_PATTERN),
    }),
  })
}

function canonicalNodeId(ref, commit) {
  const base = `code:v1:${encodeURIComponent(ref.repositoryId)}@${commit}`
  if (ref.kind === "repository") return base
  const file = `${base}:file:${encodeURIComponent(ref.path)}`
  return ref.kind === "file" ? file : `${file}:symbol:${encodeURIComponent(ref.symbol)}`
}

function normalizeNode(value, scope) {
  const node = exactRecord(
    value,
    "node",
    new Set(["id", "kind", "ref", "label", "repositoryId", "commit", "path", "symbol", "language"]),
  )
  const ref = normalizeCodeGraphRef(node.ref)
  const kind = boundedString(node.kind, "node kind", 32)
  if (!NODE_KINDS.has(kind) || kind !== ref.kind) invalid("node kind must match its reference")
  if (ref.repositoryId !== scope.repository.repositoryId || node.repositoryId !== ref.repositoryId) {
    invalid("node escaped the pinned repository scope")
  }
  if (node.commit !== scope.repository.commit) invalid("node escaped the pinned commit")
  const expectedId = canonicalNodeId(ref, scope.repository.commit)
  if (node.id !== expectedId) invalid("node id is not canonical for its reference")
  if (kind === "file" && node.path !== ref.path) invalid("file node path does not match its reference")
  if (kind === "symbol" && (node.path !== ref.path || node.symbol !== ref.symbol)) {
    invalid("symbol node identity does not match its reference")
  }
  if (kind === "repository" && (node.path !== undefined || node.symbol !== undefined)) {
    invalid("repository node cannot carry path or symbol")
  }

  const normalized = {
    id: expectedId,
    kind,
    ref,
    label: boundedString(node.label, "node label", MAX_LABEL_CHARACTERS),
    repositoryId: ref.repositoryId,
    commit: scope.repository.commit,
  }
  if (kind !== "repository") normalized.path = ref.path
  if (kind === "symbol") normalized.symbol = ref.symbol
  const language = optionalBoundedString(node.language, "node language", MAX_LANGUAGE_CHARACTERS)
  if (language !== undefined) normalized.language = language
  return Object.freeze(normalized)
}

function normalizeEdge(value, nodeIds) {
  const edge = exactRecord(value, "edge", new Set(["id", "type", "source", "target"]))
  const type = boundedString(edge.type, "edge type", 32)
  if (!EDGE_TYPES.has(type)) invalid("edge type is not supported")
  const source = boundedString(edge.source, "edge source", 4_096)
  const target = boundedString(edge.target, "edge target", 4_096)
  if (source === target) invalid("self-referential edges are not supported")
  if (!nodeIds.has(source) || !nodeIds.has(target)) invalid("edge endpoint is outside the returned neighborhood")
  const expectedId = `${type}:${source}->${target}`
  if (edge.id !== expectedId) invalid("edge id is not deterministic")
  return Object.freeze({ id: expectedId, type, source, target })
}

function sameRef(left, right) {
  return left.kind === right.kind &&
    left.repositoryId === right.repositoryId &&
    left.path === right.path &&
    left.symbol === right.symbol
}

function provenance(adapter, scope) {
  return Object.freeze({
    provider: adapter.provider,
    providerVersion: adapter.version,
    repositoryId: scope.repository.repositoryId,
    commit: scope.repository.commit,
    snapshotDigest: scope.repository.snapshotDigest,
  })
}

function normalizeAdapter(adapter) {
  const value = exactRecord(adapter, "provider adapter", new Set(["provider", "version", "resolve", "neighbors"]))
  const provider = boundedString(value.provider, "provider", MAX_PROVIDER_CHARACTERS)
  const version = boundedString(value.version, "provider version", MAX_PROVIDER_CHARACTERS)
  if (typeof value.resolve !== "function" || typeof value.neighbors !== "function") {
    invalid("provider adapter requires resolve and neighbors functions")
  }
  return { provider, version, resolve: value.resolve.bind(value), neighbors: value.neighbors.bind(value) }
}

function validateReachability(rootId, nodes, edges, maximumDepth) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    adjacency.get(edge.source).push(edge.target)
    adjacency.get(edge.target).push(edge.source)
  }
  const depthById = new Map([[rootId, 0]])
  const queue = [rootId]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const depth = depthById.get(current)
    if (depth === maximumDepth) continue
    for (const neighbor of adjacency.get(current)) {
      if (depthById.has(neighbor)) continue
      depthById.set(neighbor, depth + 1)
      queue.push(neighbor)
    }
  }
  if (depthById.size !== nodes.length) invalid("neighborhood contains nodes beyond the requested depth")
}

/**
 * Wrap a provider adapter with the Galaxy authorization, pinning, validation,
 * and result-boundary contract. Adapters receive structured requests only;
 * neither this API nor its result types admit query or Cypher strings.
 */
export function createCodeGraphProvider(rawAdapter) {
  const adapter = normalizeAdapter(rawAdapter)

  return Object.freeze({
    provider: adapter.provider,
    version: adapter.version,
    async resolve(rawRef, rawScope) {
      const ref = normalizeCodeGraphRef(rawRef)
      const scope = normalizeScope(rawScope)
      if (ref.repositoryId !== scope.repository.repositoryId) invalid("reference is outside the pinned repository scope")
      const rawResult = await adapter.resolve(Object.freeze({ ref, scope }))
      const result = exactRecord(rawResult, "resolve result", new Set(["node"]))
      const node = normalizeNode(result.node, scope)
      if (!sameRef(node.ref, ref)) invalid("provider resolved a different object")
      return Object.freeze({
        schemaId: "galaxy.code-graph.resolve.v1",
        provenance: provenance(adapter, scope),
        node,
      })
    },
    async neighbors(rawRef, rawScope, rawDepth = 1, rawLimit = 50) {
      const ref = normalizeCodeGraphRef(rawRef)
      const scope = normalizeScope(rawScope)
      if (ref.repositoryId !== scope.repository.repositoryId) invalid("reference is outside the pinned repository scope")
      if (!Number.isInteger(rawDepth) || rawDepth < 0 || rawDepth > CODE_GRAPH_MAX_DEPTH) {
        invalid(`depth must be an integer between 0 and ${CODE_GRAPH_MAX_DEPTH}`)
      }
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > CODE_GRAPH_MAX_NODES) {
        invalid(`limit must be an integer between 1 and ${CODE_GRAPH_MAX_NODES}`)
      }

      const rawResult = await adapter.neighbors(Object.freeze({
        ref,
        scope,
        depth: rawDepth,
        limit: rawLimit,
      }))
      const result = exactRecord(
        rawResult,
        "neighbors result",
        new Set(["root", "nodes", "edges", "truncated"]),
      )
      if (!Array.isArray(result.nodes) || result.nodes.length < 1 || result.nodes.length > rawLimit) {
        invalid("neighborhood node count exceeded its requested bound")
      }
      if (!Array.isArray(result.edges) || result.edges.length > CODE_GRAPH_MAX_EDGES) {
        invalid("neighborhood edge count exceeded its safe bound")
      }
      if (typeof result.truncated !== "boolean") invalid("neighborhood truncated flag must be boolean")

      const nodes = result.nodes.map((node) => normalizeNode(node, scope))
      const nodeIds = new Set(nodes.map((node) => node.id))
      if (nodeIds.size !== nodes.length) invalid("neighborhood contains duplicate node ids")
      const root = normalizeNode(result.root, scope)
      const selectedRoot = nodes.find((node) => node.id === root.id)
      if (!selectedRoot || !sameRef(root.ref, ref) || !sameRef(selectedRoot.ref, ref)) {
        invalid("neighborhood root does not match the requested reference")
      }
      const edges = result.edges.map((edge) => normalizeEdge(edge, nodeIds))
      if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
        invalid("neighborhood contains duplicate edge ids")
      }
      if (rawDepth === 0 && (nodes.length !== 1 || edges.length !== 0)) {
        invalid("a depth-zero neighborhood may contain only its root")
      }
      validateReachability(root.id, nodes, edges, rawDepth)

      return Object.freeze({
        schemaId: "galaxy.code-graph.neighborhood.v1",
        provenance: provenance(adapter, scope),
        root,
        nodes: Object.freeze(nodes),
        edges: Object.freeze(edges),
        depth: rawDepth,
        limit: rawLimit,
        truncated: result.truncated,
      })
    },
  })
}

function valueFromNode(rawNode, name) {
  if (rawNode[name] !== undefined) return rawNode[name]
  return isRecord(rawNode.properties) ? rawNode.properties[name] : undefined
}

function sourceNodeKind(value) {
  const type = boundedString(value, "source node type", 64).toLowerCase()
  if (type === "repository" || type === "project" || type === "codebase") return "repository"
  if (type === "file") return "file"
  if ([
    "symbol", "function", "method", "class", "interface", "enum", "struct",
    "trait", "module", "namespace", "theorem", "lemma", "definition", "constant",
  ].includes(type)) return "symbol"
  invalid(`unsupported source node type ${type}`)
}

const SOURCE_EDGE_TYPES = Object.freeze({
  contains: "contains",
  defines: "defines",
  imports: "imports",
  calls: "calls",
  references: "references",
  extends: "extends",
  implements: "implements",
  depends_on: "depends_on",
  "depends-on": "depends_on",
})

function sourceEdgeType(value) {
  const type = boundedString(value, "source edge type", 64).toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(SOURCE_EDGE_TYPES, type)) {
    invalid(`unsupported source edge type ${type}`)
  }
  return SOURCE_EDGE_TYPES[type]
}

function freezeNode(ref, scope, label, language) {
  const node = {
    id: canonicalNodeId(ref, scope.repository.commit),
    kind: ref.kind,
    ref,
    label,
    repositoryId: ref.repositoryId,
    commit: scope.repository.commit,
  }
  if (ref.kind !== "repository") node.path = ref.path
  if (ref.kind === "symbol") node.symbol = ref.symbol
  if (language !== undefined) node.language = language
  return Object.freeze(node)
}

/**
 * Adapt a supplied, inert codebase-memory-style JSON snapshot. This function
 * never installs a binary, opens a repository, or evaluates a graph query.
 */
export function createCodebaseMemoryJsonProvider(rawSnapshot) {
  const snapshot = exactRecord(
    rawSnapshot,
    "codebase-memory snapshot",
    new Set(["schemaVersion", "provider", "repository", "snapshot", "nodes", "edges"]),
  )
  if (snapshot.schemaVersion !== "codebase-memory.snapshot.v1") invalid("unsupported snapshot schemaVersion")
  const providerMetadata = exactRecord(snapshot.provider, "snapshot provider", new Set(["name", "version"]))
  const provider = boundedString(providerMetadata.name, "provider", MAX_PROVIDER_CHARACTERS)
  const version = boundedString(providerMetadata.version, "provider version", MAX_PROVIDER_CHARACTERS)
  const repositoryMetadata = exactRecord(
    snapshot.repository,
    "snapshot repository",
    new Set(["repositoryId", "commit"]),
  )
  const repositoryId = normalizeRepositoryId(repositoryMetadata.repositoryId)
  const commit = boundedString(repositoryMetadata.commit, "commit", 64, COMMIT_PATTERN)
  const snapshotMetadata = exactRecord(snapshot.snapshot, "snapshot identity", new Set(["digest"]))
  const snapshotDigest = boundedString(snapshotMetadata.digest, "snapshot digest", 71, SNAPSHOT_PATTERN)
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length < 1 || snapshot.nodes.length > MAX_SOURCE_NODES) {
    invalid("snapshot nodes are outside the ingestion bound")
  }
  if (!Array.isArray(snapshot.edges) || snapshot.edges.length > MAX_SOURCE_EDGES) {
    invalid("snapshot edges are outside the ingestion bound")
  }

  const pinnedScope = Object.freeze({ repository: Object.freeze({ repositoryId, commit, snapshotDigest }) })
  const sourceToNode = new Map()
  const canonicalIds = new Set()
  for (const value of snapshot.nodes) {
    const rawNode = exactRecord(
      value,
      "source node",
      new Set(["id", "type", "path", "name", "qualifiedName", "label", "language", "properties"]),
    )
    if (rawNode.properties !== undefined && !isRecord(rawNode.properties)) {
      invalid("source node properties must be an object")
    }
    const sourceId = boundedString(rawNode.id, "source node id", MAX_IDENTIFIER_CHARACTERS)
    if (sourceToNode.has(sourceId)) invalid("snapshot contains duplicate source node ids")
    const kind = sourceNodeKind(rawNode.type)
    let ref
    if (kind === "repository") {
      ref = Object.freeze({ kind, repositoryId })
    } else if (kind === "file") {
      ref = Object.freeze({ kind, repositoryId, path: normalizePath(valueFromNode(rawNode, "path")) })
    } else {
      const path = normalizePath(valueFromNode(rawNode, "path"))
      const symbol = normalizeSymbol(
        valueFromNode(rawNode, "qualifiedName") ?? valueFromNode(rawNode, "name"),
      )
      ref = Object.freeze({ kind, repositoryId, path, symbol })
    }
    const label = boundedString(
      valueFromNode(rawNode, "label") ?? valueFromNode(rawNode, "qualifiedName") ??
        valueFromNode(rawNode, "name") ?? (kind === "repository" ? repositoryId : ref.path),
      "source node label",
      MAX_LABEL_CHARACTERS,
    )
    const language = optionalBoundedString(valueFromNode(rawNode, "language"), "source language", MAX_LANGUAGE_CHARACTERS)
    const node = freezeNode(ref, pinnedScope, label, language)
    if (canonicalIds.has(node.id)) invalid("snapshot contains duplicate normalized node identities")
    canonicalIds.add(node.id)
    sourceToNode.set(sourceId, node)
  }

  const edges = []
  const edgeIds = new Set()
  for (const value of snapshot.edges) {
    const rawEdge = exactRecord(value, "source edge", new Set(["id", "type", "source", "target", "properties"]))
    if (rawEdge.properties !== undefined && !isRecord(rawEdge.properties)) {
      invalid("source edge properties must be an object")
    }
    const sourceId = boundedString(rawEdge.source, "source edge source", MAX_IDENTIFIER_CHARACTERS)
    const targetId = boundedString(rawEdge.target, "source edge target", MAX_IDENTIFIER_CHARACTERS)
    const source = sourceToNode.get(sourceId)
    const target = sourceToNode.get(targetId)
    if (!source || !target) invalid("source edge endpoint is missing from the snapshot")
    if (source.id === target.id) invalid("source edge normalized to a self-reference")
    const type = sourceEdgeType(rawEdge.type)
    const id = `${type}:${source.id}->${target.id}`
    if (edgeIds.has(id)) continue
    edgeIds.add(id)
    edges.push(Object.freeze({ id, type, source: source.id, target: target.id }))
  }

  const nodes = Object.freeze([...sourceToNode.values()].sort((left, right) => left.id.localeCompare(right.id)))
  const sortedEdges = Object.freeze(edges.sort((left, right) => left.id.localeCompare(right.id)))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of sortedEdges) {
    adjacency.get(edge.source).push(edge.target)
    adjacency.get(edge.target).push(edge.source)
  }

  function assertPinnedRequest(request) {
    if (request.scope.repository.repositoryId !== repositoryId ||
      request.scope.repository.commit !== commit ||
      request.scope.repository.snapshotDigest !== snapshotDigest) {
      invalid("requested repository pin does not match the loaded snapshot")
    }
  }

  function nodeForRef(ref) {
    return nodesById.get(canonicalNodeId(ref, commit)) ?? null
  }

  return createCodeGraphProvider({
    provider,
    version,
    async resolve(request) {
      assertPinnedRequest(request)
      const node = nodeForRef(request.ref)
      if (!node) invalid("reference does not exist in the pinned snapshot")
      return { node }
    },
    async neighbors(request) {
      assertPinnedRequest(request)
      const root = nodeForRef(request.ref)
      if (!root) invalid("reference does not exist in the pinned snapshot")
      const selected = new Set([root.id])
      const queue = [{ id: root.id, depth: 0 }]
      let truncated = false
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]
        if (current.depth === request.depth) continue
        for (const neighbor of [...adjacency.get(current.id)].sort()) {
          if (selected.has(neighbor)) continue
          if (selected.size === request.limit) {
            truncated = true
            continue
          }
          selected.add(neighbor)
          queue.push({ id: neighbor, depth: current.depth + 1 })
        }
      }
      const selectedNodes = nodes.filter((node) => selected.has(node.id))
      const selectedEdges = sortedEdges.filter((edge) => selected.has(edge.source) && selected.has(edge.target))
      if (selectedEdges.length > CODE_GRAPH_MAX_EDGES) {
        invalid("snapshot neighborhood exceeded the edge safety bound")
      }
      return { root, nodes: selectedNodes, edges: selectedEdges, truncated }
    },
  })
}

export function createCodeGraphObjectId(rawRef) {
  const ref = normalizeCodeGraphRef(rawRef)
  const parts = ["code", "v1", encodeURIComponent(ref.repositoryId)]
  if (ref.kind !== "repository") parts.push(encodeURIComponent(ref.path))
  if (ref.kind === "symbol") parts.push(encodeURIComponent(ref.symbol))
  const objectId = parts.join(":")
  if (Array.from(objectId).length > MAX_IDENTIFIER_CHARACTERS) {
    invalid("canonical code object id exceeds the Galaxy object-reference bound")
  }
  return objectId
}

export function parseCodeGraphObjectId(kind, value) {
  if (!GALAXY_CODE_KINDS.has(kind) || typeof value !== "string" ||
    Array.from(value).length > MAX_IDENTIFIER_CHARACTERS) return null
  const parts = value.split(":")
  const expectedLength = kind === "code.file" ? 4 : kind === "code.symbol" ? 5 : 3
  if (parts.length !== expectedLength || parts[0] !== "code" || parts[1] !== "v1") return null
  try {
    const repositoryId = normalizeRepositoryId(decodeSegment(parts[2], "repositoryId"))
    if (expectedLength === 3) return Object.freeze({ kind: "repository", repositoryId })
    const path = normalizePath(decodeSegment(parts[3], "path"))
    if (expectedLength === 4) return Object.freeze({ kind: "file", repositoryId, path })
    return Object.freeze({
      kind: "symbol",
      repositoryId,
      path,
      symbol: normalizeSymbol(decodeSegment(parts[4], "symbol")),
    })
  } catch {
    return null
  }
}

export function createCodeGraphRevision(commit, snapshotDigest) {
  const normalizedCommit = boundedString(commit, "commit", 64, COMMIT_PATTERN)
  const normalizedDigest = boundedString(snapshotDigest, "snapshotDigest", 71, SNAPSHOT_PATTERN)
  return `git:${normalizedCommit};snapshot:${normalizedDigest}`
}

export function parseCodeGraphRevision(value) {
  if (typeof value !== "string") return null
  const match = /^git:([a-f0-9]{40}|[a-f0-9]{64});snapshot:(sha256:[a-f0-9]{64})$/u.exec(value)
  return match ? Object.freeze({ commit: match[1], snapshotDigest: match[2] }) : null
}

/** Map a parsed canonical Galaxy code reference to a pinned provider request. */
export function codeGraphRequestFromGalaxyObjectReference(reference, rawAuthorityScope) {
  if (!isRecord(reference) || reference.schema !== "gb.object-ref.v1" || reference.format !== "canonical" ||
    !GALAXY_CODE_KINDS.has(reference.kind) || !isRecord(reference.selector) ||
    reference.selector.mode !== "pinned") return null
  const ref = parseCodeGraphObjectId(reference.kind, reference.id)
  const revision = parseCodeGraphRevision(reference.selector.revision)
  if (!ref || !revision) return null
  try {
    const authority = exactRecord(rawAuthorityScope, "authority scope", new Set(["tenantId", "authorityScope"]))
    const scope = normalizeScope({
      tenantId: authority.tenantId,
      authorityScope: authority.authorityScope,
      repository: { repositoryId: ref.repositoryId, ...revision },
    })
    return Object.freeze({ objectKind: reference.kind, ref, scope })
  } catch {
    return null
  }
}

/**
 * Project a deterministic provider edge into the durable relation vocabulary.
 * `contains` remains provider-owned navigation and is intentionally not a
 * durable assertion. A `defines` edge is inverted so it reads naturally as
 * `symbol defined_in file`.
 */
export function projectCodeGraphEdgeToDurableRelation(value) {
  try {
    const edge = exactRecord(value, "edge projection", new Set(["id", "type", "source", "target"]))
    const type = boundedString(edge.type, "edge type", 32)
    if (!EDGE_TYPES.has(type)) return null
    const source = boundedString(edge.source, "edge source", 4_096)
    const target = boundedString(edge.target, "edge target", 4_096)
    if (edge.id !== `${type}:${source}->${target}` || source === target) return null
    if (type === "contains") return null
    if (type === "defines") {
      return Object.freeze({ relation: "defined_in", fromNodeId: target, toNodeId: source })
    }
    if (type === "implements") {
      return Object.freeze({ relation: "implements", fromNodeId: source, toNodeId: target })
    }
    return Object.freeze({ relation: "depends_on", fromNodeId: source, toNodeId: target })
  } catch {
    return null
  }
}

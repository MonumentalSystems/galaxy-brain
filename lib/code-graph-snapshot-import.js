import { createCodebaseMemoryJsonProvider } from "./code-graph-provider.js"

export const CODE_GRAPH_SNAPSHOT_MEDIA_TYPE = "application/json"
export const MAX_CODE_GRAPH_SNAPSHOT_BYTES = 32 * 1024 * 1024
export const CODE_GRAPH_SNAPSHOT_SCHEMA_ID = "codebase-memory.snapshot.v1"

const MAX_JSON_DEPTH = 64
const MAX_JSON_VALUES = 2_000_000
const MAX_JSON_KEY_CHARACTERS = 512
const MAX_JSON_STRING_CHARACTERS = 65_536
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const DECLARED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u

export class CodeGraphSnapshotImportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "CodeGraphSnapshotImportError"
    this.code = code
  }
}

function fail(code, message) {
  throw new CodeGraphSnapshotImportError(code, message)
}

function characterLength(value) {
  return Array.from(value).length
}

function parseStrictJson(text) {
  let offset = 0
  let values = 0

  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) offset += 1
  }

  const countValue = () => {
    values += 1
    if (values > MAX_JSON_VALUES) fail("structure", "The snapshot contains too many JSON values.")
  }

  const readString = (isKey = false) => {
    const start = offset
    if (text[offset] !== '"') fail("json", "The snapshot is not valid JSON.")
    offset += 1
    while (offset < text.length) {
      const character = text[offset]
      if (character === '"') {
        offset += 1
        let value
        try {
          value = JSON.parse(text.slice(start, offset))
        } catch {
          fail("json", "The snapshot contains an invalid JSON string.")
        }
        const maximum = isKey ? MAX_JSON_KEY_CHARACTERS : MAX_JSON_STRING_CHARACTERS
        if (characterLength(value) > maximum) {
          fail("structure", isKey
            ? "The snapshot contains an oversized JSON field name."
            : "The snapshot contains an oversized JSON string.")
        }
        return value
      }
      if (character === "\\") {
        offset += 1
        const escape = text[offset]
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/u.test(text.slice(offset + 1, offset + 5))) {
            fail("json", "The snapshot contains an invalid JSON escape.")
          }
          offset += 5
          continue
        }
        if (!'"\\/bfnrt'.includes(escape || "")) fail("json", "The snapshot contains an invalid JSON escape.")
        offset += 1
        continue
      }
      if (character.charCodeAt(0) < 0x20) fail("json", "The snapshot contains an invalid control character.")
      offset += 1
    }
    fail("json", "The snapshot contains an unterminated JSON string.")
  }

  const readNumber = () => {
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
    if (!match) fail("json", "The snapshot contains an invalid JSON number.")
    offset += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) fail("json", "The snapshot contains a non-finite number.")
    return value
  }

  const readValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) fail("structure", "The snapshot exceeds the JSON nesting limit.")
    skipWhitespace()
    countValue()
    const character = text[offset]
    if (character === '"') return readString()
    if (character === "{") {
      offset += 1
      skipWhitespace()
      const result = {}
      const keys = new Set()
      if (text[offset] === "}") {
        offset += 1
        return result
      }
      while (offset < text.length) {
        skipWhitespace()
        const key = readString(true)
        if (keys.has(key)) fail("duplicate-key", "The snapshot contains a duplicate JSON field.")
        keys.add(key)
        skipWhitespace()
        if (text[offset] !== ":") fail("json", "The snapshot is not valid JSON.")
        offset += 1
        const value = readValue(depth + 1)
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
        skipWhitespace()
        if (text[offset] === "}") {
          offset += 1
          return result
        }
        if (text[offset] !== ",") fail("json", "The snapshot is not valid JSON.")
        offset += 1
      }
      fail("json", "The snapshot contains an unterminated JSON object.")
    }
    if (character === "[") {
      offset += 1
      skipWhitespace()
      const result = []
      if (text[offset] === "]") {
        offset += 1
        return result
      }
      while (offset < text.length) {
        result.push(readValue(depth + 1))
        skipWhitespace()
        if (text[offset] === "]") {
          offset += 1
          return result
        }
        if (text[offset] !== ",") fail("json", "The snapshot is not valid JSON.")
        offset += 1
      }
      fail("json", "The snapshot contains an unterminated JSON array.")
    }
    if (text.startsWith("true", offset)) {
      offset += 4
      return true
    }
    if (text.startsWith("false", offset)) {
      offset += 5
      return false
    }
    if (text.startsWith("null", offset)) {
      offset += 4
      return null
    }
    if (character === "-" || /[0-9]/u.test(character || "")) return readNumber()
    fail("json", "The snapshot is not valid JSON.")
  }

  const parsed = readValue(0)
  skipWhitespace()
  if (offset !== text.length) fail("json", "The snapshot contains data after its JSON value.")
  return parsed
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

function exactSnapshotSummary(value, byteSize, contentSha256) {
  try {
    const provider = createCodebaseMemoryJsonProvider(value)
    const repository = value.repository
    const snapshot = value.snapshot
    if (
      value.schemaVersion !== CODE_GRAPH_SNAPSHOT_SCHEMA_ID
      || typeof repository?.repositoryId !== "string"
      || typeof repository?.commit !== "string"
      || !COMMIT_PATTERN.test(repository.commit)
      || typeof snapshot?.digest !== "string"
      || !DECLARED_DIGEST_PATTERN.test(snapshot.digest)
      || !Array.isArray(value.nodes)
      || !Array.isArray(value.edges)
    ) fail("schema", "The JSON does not match the supported Codebase Memory snapshot schema.")
    return Object.freeze({
      schemaId: CODE_GRAPH_SNAPSHOT_SCHEMA_ID,
      contentSha256,
      byteSize,
      provider: Object.freeze({ name: provider.provider, version: provider.version }),
      repository: Object.freeze({ repositoryId: repository.repositoryId, commit: repository.commit }),
      declaredSnapshotDigest: snapshot.digest,
      nodeCount: value.nodes.length,
      edgeCount: value.edges.length,
    })
  } catch (error) {
    if (error instanceof CodeGraphSnapshotImportError) throw error
    fail("schema", "The JSON does not match the supported Codebase Memory snapshot schema.")
  }
}

async function decodeCodeGraphSnapshotBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CODE_GRAPH_SNAPSHOT_BYTES) {
    fail("size", `Choose a non-empty JSON snapshot no larger than ${MAX_CODE_GRAPH_SNAPSHOT_BYTES.toLocaleString()} bytes.`)
  }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    fail("encoding", "The snapshot must be valid UTF-8 JSON.")
  }
  const value = parseStrictJson(text)
  const contentSha256 = await sha256Hex(bytes)
  return { bytes, value, contentSha256 }
}

export function validateCodeGraphSnapshotFileDescriptor(file) {
  if (!file || typeof file.name !== "string" || typeof file.size !== "number" || typeof file.type !== "string") {
    fail("file", "Choose one local Codebase Memory JSON snapshot.")
  }
  if (!file.name.toLowerCase().endsWith(".json")) {
    fail("file", "Choose a file whose name ends in .json.")
  }
  if (file.size < 1 || file.size > MAX_CODE_GRAPH_SNAPSHOT_BYTES) {
    fail("size", `Choose a non-empty JSON snapshot no larger than ${MAX_CODE_GRAPH_SNAPSHOT_BYTES.toLocaleString()} bytes.`)
  }
  if (file.type && file.type.toLowerCase() !== CODE_GRAPH_SNAPSHOT_MEDIA_TYPE) {
    fail("media-type", "Choose a JSON file whose declared media type is application/json.")
  }
  return Object.freeze({ name: file.name, byteSize: file.size, mediaType: CODE_GRAPH_SNAPSHOT_MEDIA_TYPE })
}

export async function parseCodeGraphSnapshotBytes(input) {
  const { bytes, value, contentSha256 } = await decodeCodeGraphSnapshotBytes(input)
  return exactSnapshotSummary(value, bytes.byteLength, contentSha256)
}

/**
 * Strictly parse an exact snapshot and retain its inert provider. Interactive
 * graph lenses use smaller caps than durable admission so a valid archival
 * snapshot cannot monopolize a browser worker.
 */
export async function openCodeGraphSnapshotProvider(input, options = {}) {
  const maximumNodes = Number.isSafeInteger(options.maxNodes) ? options.maxNodes : 100_000
  const maximumEdges = Number.isSafeInteger(options.maxEdges) ? options.maxEdges : 500_000
  if (maximumNodes < 1 || maximumNodes > 100_000 || maximumEdges < 0 || maximumEdges > 500_000) {
    fail("source-bound", "The snapshot provider bounds are invalid.")
  }
  const { bytes, value, contentSha256 } = await decodeCodeGraphSnapshotBytes(input)
  if (!Array.isArray(value?.nodes) || value.nodes.length > maximumNodes
    || !Array.isArray(value?.edges) || value.edges.length > maximumEdges) {
    fail(
      "source-bound",
      `This graph lens supports at most ${maximumNodes.toLocaleString()} nodes and ${maximumEdges.toLocaleString()} edges.`,
    )
  }
  const review = exactSnapshotSummary(value, bytes.byteLength, contentSha256)
  return Object.freeze({ review, provider: createCodebaseMemoryJsonProvider(value) })
}

export function normalizeCodeGraphSnapshotReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("worker", "Snapshot review returned an invalid result.")
  const keys = Object.keys(value).sort()
  if (keys.join("\n") !== [
    "byteSize", "contentSha256", "declaredSnapshotDigest", "edgeCount", "nodeCount",
    "provider", "repository", "schemaId",
  ].sort().join("\n")) fail("worker", "Snapshot review returned unsupported fields.")
  const providerKeys = value.provider && typeof value.provider === "object" && !Array.isArray(value.provider)
    ? Object.keys(value.provider).sort().join("\n") : ""
  const repositoryKeys = value.repository && typeof value.repository === "object" && !Array.isArray(value.repository)
    ? Object.keys(value.repository).sort().join("\n") : ""
  if (
    value.schemaId !== CODE_GRAPH_SNAPSHOT_SCHEMA_ID
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > MAX_CODE_GRAPH_SNAPSHOT_BYTES
    || typeof value.contentSha256 !== "string" || !SHA256_PATTERN.test(value.contentSha256)
    || providerKeys !== "name\nversion"
    || typeof value.provider.name !== "string" || !value.provider.name
    || typeof value.provider.version !== "string" || !value.provider.version
    || repositoryKeys !== "commit\nrepositoryId"
    || typeof value.repository.repositoryId !== "string" || !value.repository.repositoryId
    || typeof value.repository.commit !== "string" || !COMMIT_PATTERN.test(value.repository.commit)
    || typeof value.declaredSnapshotDigest !== "string" || !DECLARED_DIGEST_PATTERN.test(value.declaredSnapshotDigest)
    || !Number.isSafeInteger(value.nodeCount) || value.nodeCount < 1 || value.nodeCount > 100_000
    || !Number.isSafeInteger(value.edgeCount) || value.edgeCount < 0 || value.edgeCount > 500_000
  ) fail("worker", "Snapshot review returned an invalid result.")
  return Object.freeze({
    schemaId: value.schemaId,
    contentSha256: value.contentSha256,
    byteSize: value.byteSize,
    provider: Object.freeze({ name: value.provider.name, version: value.provider.version }),
    repository: Object.freeze({ repositoryId: value.repository.repositoryId, commit: value.repository.commit }),
    declaredSnapshotDigest: value.declaredSnapshotDigest,
    nodeCount: value.nodeCount,
    edgeCount: value.edgeCount,
  })
}

export function createCodeGraphSnapshotImportTitle(review) {
  const normalized = normalizeCodeGraphSnapshotReview(review)
  const repository = Array.from(normalized.repository.repositoryId).slice(0, 170).join("")
  return `Code graph: ${repository} @ ${normalized.repository.commit.slice(0, 12)}`
}

export function assertCodeGraphSnapshotImportConfirmation(confirmation, review, filename) {
  const normalized = normalizeCodeGraphSnapshotReview(review)
  const document = confirmation?.document
  if (
    !document
    || document.media_type !== CODE_GRAPH_SNAPSHOT_MEDIA_TYPE
    || document.content_sha256 !== normalized.contentSha256
    || document.byte_size !== normalized.byteSize
    || document.original_filename !== filename
  ) fail("confirmation", "The stored document confirmation did not match the reviewed exact JSON bytes.")
  return confirmation
}

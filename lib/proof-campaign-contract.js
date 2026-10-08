const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
export const PROOF_CAMPAIGN_MANIFEST_MAX_BYTES = 1_048_576
export const PROOF_CAMPAIGN_UPSTREAM_RESPONSE_MAX_BYTES = 1_048_576

export class ProofCampaignContractError extends Error {
  constructor(message, status = 422) {
    super(message)
    this.name = "ProofCampaignContractError"
    this.status = status
  }
}

function invalid(message, status = 422) {
  throw new ProofCampaignContractError(message, status)
}

async function readBoundedBytes(body, contentLength, maxBytes, tooLargeMessage, status) {
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    invalid(tooLargeMessage, status)
  }
  if (!body) return new Uint8Array()

  const reader = body.getReader()
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        invalid(tooLargeMessage, status)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readProofCampaignJsonBody(
  request,
  maxBytes = PROOF_CAMPAIGN_MANIFEST_MAX_BYTES,
) {
  if (!request.body) invalid("campaign request body must contain JSON", 400)
  const bytes = await readBoundedBytes(
    request.body,
    request.headers.get("content-length"),
    maxBytes,
    `campaign request exceeds ${maxBytes} bytes`,
    413,
  )
  let raw
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(raw)
  } catch {
    invalid("campaign request body must contain valid UTF-8 JSON", 400)
  }
}

export async function readProofCampaignResponseText(
  response,
  maxBytes = PROOF_CAMPAIGN_UPSTREAM_RESPONSE_MAX_BYTES,
) {
  const bytes = await readBoundedBytes(
    response.body,
    response.headers.get("content-length"),
    maxBytes,
    `Hyades proof campaign response exceeds ${maxBytes} bytes`,
    502,
  )
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    invalid("Hyades proof campaign response is not valid UTF-8", 502)
  }
}

export function parseProofCampaignManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("campaign manifest must be a JSON object")
  }
  if (input.schema_id !== "ham.audit-program.v3") {
    invalid("campaign manifest must use schema_id ham.audit-program.v3")
  }
  if (typeof input.program_id !== "string" || !PROGRAM_ID_PATTERN.test(input.program_id)) {
    invalid("campaign manifest program_id is invalid")
  }
  if (!Array.isArray(input.packets) || input.packets.length === 0) {
    invalid("campaign manifest must contain at least one packet")
  }
  let bytes
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
  } catch {
    invalid("campaign manifest must be JSON-serializable")
  }
  if (bytes > PROOF_CAMPAIGN_MANIFEST_MAX_BYTES) {
    invalid(`campaign manifest exceeds ${PROOF_CAMPAIGN_MANIFEST_MAX_BYTES} bytes`, 413)
  }
  return input
}

export function fillMissingProofCampaignSequenceIndexes(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.packets)) {
    return input
  }
  let changed = false
  const packets = input.packets.map((packet, index) => {
    if (!packet || typeof packet !== "object" || Array.isArray(packet) || Object.hasOwn(packet, "sequence_index")) {
      return packet
    }
    changed = true
    return { ...packet, sequence_index: index + 1 }
  })
  return changed ? { ...input, packets } : input
}

export function parseDirectiveSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("expectedDirectiveSha256 must be a lowercase SHA-256", 400)
  }
  return value
}

export function parseProgramId(value) {
  if (typeof value !== "string" || !PROGRAM_ID_PATTERN.test(value)) {
    invalid("programId is invalid", 400)
  }
  return value
}

export function createProofCampaignDispatchBody(input, programId, project) {
  const source = input && typeof input === "object" ? input : {}
  if (source.confirmProgramId !== programId) {
    invalid("dispatch confirmation must exactly match the program ID", 400)
  }
  return {
    expectedDirectiveSha256: parseDirectiveSha256(source.expectedDirectiveSha256),
    project,
    explicitAuthority: true,
  }
}

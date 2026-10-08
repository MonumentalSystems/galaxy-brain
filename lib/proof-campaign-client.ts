export type ProofCampaignPreview = {
  programId: string
  programSha256: string
  progressSha256: string
  directiveSha256: string
  readyPacketIds: string[]
  authorityGranted: false
  sideEffectsAuthorized: false
  directive: { decision?: string; targets?: Array<{ packet_id?: string; packetId?: string }> }
}

export type ProofCampaignDispatchTask = {
  packetId?: string
  taskId?: string
  state?: string
}

export type ProofCampaignDispatchReceipt = {
  dispatchId?: string
  directiveSha256?: string
  state?: string
  tasks?: ProofCampaignDispatchTask[]
}

async function requestProofCampaign(programId: string, operation: string, body?: unknown) {
  const response = await fetch(`/api/proof-campaigns/${encodeURIComponent(programId)}/${operation}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || "Proof campaign request failed")
  return payload
}

export async function previewProofCampaign(manifest: Record<string, unknown>) {
  const payload = await requestProofCampaign(String(manifest.program_id), "preview", manifest)
  return payload.preview as ProofCampaignPreview
}

export function registerProofCampaign(manifest: Record<string, unknown>) {
  return requestProofCampaign(String(manifest.program_id), "register", manifest)
}

export function fetchProofCampaignStatus(programId: string) {
  return requestProofCampaign(programId, "status")
}

export async function dispatchProofCampaign(programId: string, expectedDirectiveSha256: string) {
  const payload = await requestProofCampaign(programId, "dispatch", {
    expectedDirectiveSha256,
    confirmProgramId: programId,
  })
  if (!payload?.receipt || typeof payload.receipt !== "object") {
    throw new Error("Hyades returned no dispatch receipt")
  }
  return payload.receipt as ProofCampaignDispatchReceipt
}

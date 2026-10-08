import { parseProgramId } from "./proof-campaign-contract.js"

export const PROOF_CAMPAIGN_PROXY_OPERATIONS = Object.freeze({
  preview: { method: "POST", mutates: false },
  register: { method: "POST", mutates: true },
  status: { method: "GET", mutates: false },
  registration: { method: "GET", mutates: false },
  dispatch: { method: "POST", mutates: true },
})

export function getProofCampaignProxyRoute(operation, refs = {}) {
  if (!Object.hasOwn(PROOF_CAMPAIGN_PROXY_OPERATIONS, operation)) {
    throw new Error(`proof campaign proxy operation is not allowed: ${operation}`)
  }
  const policy = PROOF_CAMPAIGN_PROXY_OPERATIONS[operation]
  const tenant = encodeURIComponent(String(refs.hyadesTenant || ""))
  if (!tenant) throw new Error("hyadesTenant is required")
  const programId = encodeURIComponent(parseProgramId(refs.programId))
  const root = `/admin/ham/programs/${tenant}/${programId}`
  if (operation === "status") return { ...policy, path: root }
  return { ...policy, path: `${root}/${operation}` }
}

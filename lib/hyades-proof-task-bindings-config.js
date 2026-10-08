export function resolveHyadesProofTaskBindingsUrl(environment, graphRef) {
  const configured = environment.HYADES_PROOF_TASK_BINDINGS_API_INTERNAL
  if (typeof configured !== "string" || !configured.trim()) return null
  let base
  try { base = new URL(configured) } catch { return null }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password
    || base.search || base.hash) return null
  const prefix = base.pathname.replace(/\/$/u, "")
  base.pathname = `${prefix}/ham/proof-task-bindings/${encodeURIComponent(graphRef.graph_id)}`
  base.searchParams.set("content_sha256", graphRef.content_sha256)
  return base
}

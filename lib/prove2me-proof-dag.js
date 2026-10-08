/**
 * Converts a Prove2me decomposition graph into a galaxy.proof-dag.v1 document.
 *
 * Prove2me returns a bipartite graph: `nodes` are either theorems or sketches
 * (a sketch proves its parent by importing child theorems), and sketch nodes are
 * keyed by `node_id` rather than `theorem_id`. Its `edges` come in two kinds:
 *
 *   - "sketch"     child theorem -> sketch, and sketch -> parent theorem
 *   - "structural" theorem -> theorem, already resolved through the sketches
 *
 * Only the structural edges are needed. Their source is the prerequisite and
 * their target is the dependent, which is the direction galaxy.proof-dag.v1
 * relations already use, so no inversion is involved.
 */

const MAX_SUMMARY = 4_000

function invalid(message) {
  throw new Error(message)
}

/**
 * @param graph the parsed body of GET /api/v1/theorems/:id/graph
 * Import is always passive. A Prove2Me subtree is useful structural input,
 * but remote status and the presence of one root theorem do not authorize
 * Galaxy coordination. An active mission must be derived from the exact
 * registered source by Galaxy's server-authoritative mission contract.
 * @param options retained only to reject the removed active-import policy
 * @returns a galaxy.proof-dag.v1 document, ready for parseProofDag
 */
export function prove2meGraphToProofDag(graph, options = {}) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    invalid("Prove2me graph must be a JSON object")
  }
  if (typeof graph.root_id !== "string" || !graph.root_id) {
    invalid("Prove2me graph must carry a root_id")
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    invalid("Prove2me graph must carry nodes and edges arrays")
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    invalid("Prove2me conversion options must be an object")
  }
  const optionNames = Object.keys(options)
  if (optionNames.length > 0) {
    if (optionNames.includes("activateMission")) {
      invalid("activateMission is no longer supported; derive missions from the exact registered passive graph")
    }
    invalid(`Unsupported Prove2me conversion option ${optionNames[0]}`)
  }
  const theorems = graph.nodes.filter((node) => node && node.node_type === "theorem")
  if (theorems.length === 0) invalid("Prove2me graph contained no theorem nodes")

  const byId = new Map()
  for (const node of theorems) {
    if (typeof node.theorem_id !== "string" || !node.theorem_id) {
      invalid("Prove2me theorem node is missing theorem_id")
    }
    byId.set(node.theorem_id, node)
  }

  const seen = new Set()
  const relations = []
  for (const edge of graph.edges) {
    if (!edge || edge.kind !== "structural") continue
    // Sketch endpoints and nodes outside this subtree are not proof targets.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    if (edge.source === edge.target) continue
    const relationId = `${edge.source}->${edge.target}`
    if (seen.has(relationId)) continue
    seen.add(relationId)
    relations.push({
      relation_id: relationId,
      relation_type: "REDUCES_TO",
      prerequisite_target_id: edge.source,
      dependent_target_id: edge.target,
    })
  }

  const root = byId.get(graph.root_id)

  return {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: graph.root_id,
    graph_kind: "repository-field",
    title: (root && (root.theorem_title || root.theorem_name)) || "Prove2me decomposition",
    targets: theorems.map((node) => ({
      target_id: node.theorem_id,
      target_kind: "formal-target",
      title: node.theorem_title || node.theorem_name || node.theorem_id,
      natural_language_summary: String(node.natural_language_statement || "").slice(0, MAX_SUMMARY),
      category: "prove2me-theorem",
      external: { prove2me: { theorem_id: node.theorem_id } },
    })),
    relations,
  }
}

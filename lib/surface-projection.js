const APPROVED_COMPONENT_TYPES = new Set([
  "Badge",
  "Card",
  "Charts",
  "Column",
  "DataTable",
  "Grid",
  "Heading",
  "KnowledgeGraph",
  "Markdown",
  "Row",
  "Separator",
  "Stack",
  "StatsDisplay",
  "SVGPreview",
  "Text",
  "Timeline",
  "Title",
])
const APPROVED_BINDING_KINDS = new Set([
  "galaxy.eln.experiment",
  "galaxy.eln.hypothesis",
  "galaxy.ham.task",
])
const FORBIDDEN_KEYS = new Set([
  "action",
  "actions",
  "handler",
  "script",
  "__proto__",
  "prototype",
  "constructor",
  "dangerouslySetInnerHTML",
  "srcDoc",
])

function boundedValue(value, depth = 0, counter = { value: 0 }) {
  counter.value += 1
  if (depth > 10 || counter.value > 4096) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") {
    const normalized = value.toLowerCase()
    return value.length <= 20_000 && !normalized.includes("javascript:") && !normalized.includes("<script")
  }
  if (Array.isArray(value)) return value.every((item) => boundedValue(item, depth + 1, counter))
  if (!value || typeof value !== "object") return false
  return Object.entries(value).every(([key, item]) =>
    !FORBIDDEN_KEYS.has(key) && !/^on[A-Z_]/.test(key) && boundedValue(item, depth + 1, counter),
  )
}

/**
 * Turn an untrusted persisted surface into a renderer-friendly tree. The API
 * validates on write; this second boundary keeps the browser fail-closed if a
 * legacy or manually edited row ever bypasses that validation.
 *
 * @param {unknown} value
 * @returns {{ ok: true, roots: Array<object>, bindings: Array<object> } | { ok: false, error: string }}
 */
export function projectSurface(value) {
  if (!value || typeof value !== "object") return invalid("Surface spec is not an object")
  const spec = /** @type {Record<string, any>} */ (value)
  if (spec.schema !== "gb.surface.v1") return invalid("Unsupported surface schema")
  if (spec.catalog?.id !== "generous.a2ui" || spec.catalog?.version !== "1") {
    return invalid("Unsupported component catalog")
  }
  const components = spec.surfaceUpdate?.components
  if (!Array.isArray(components) || components.length < 1 || components.length > 64) {
    return invalid("Surface component count is outside the bounded contract")
  }

  const byId = new Map()
  for (const component of components) {
    if (!component || typeof component !== "object" || typeof component.id !== "string") {
      return invalid("Surface contains an invalid component")
    }
    if (byId.has(component.id)) return invalid(`Duplicate component id: ${component.id}`)
    const entries = Object.entries(component.component ?? {})
    if (entries.length !== 1 || !APPROVED_COMPONENT_TYPES.has(entries[0][0])) {
      return invalid(`Surface contains an unapproved component: ${entries[0]?.[0] ?? "unknown"}`)
    }
    const props = entries[0][1]
    if (!props || typeof props !== "object" || Array.isArray(props)) {
      return invalid(`Component ${component.id} has invalid properties`)
    }
    if (!boundedValue(props)) return invalid(`Component ${component.id} has unsafe properties`)
    byId.set(component.id, {
      id: component.id,
      type: entries[0][0],
      props,
      childIds: [],
      children: [],
    })
  }

  const parentById = new Map()
  for (const component of components) {
    if (component.parentId !== undefined) {
      if (!byId.has(component.parentId)) return invalid(`Unknown parent component: ${component.parentId}`)
      parentById.set(component.id, component.parentId)
    }
    if (component.children !== undefined && !Array.isArray(component.children)) {
      return invalid(`Component ${component.id} has invalid children`)
    }
    for (const childId of component.children ?? []) {
      if (!byId.has(childId)) return invalid(`Unknown child component: ${childId}`)
      const existingParent = parentById.get(childId)
      if (existingParent && existingParent !== component.id) {
        return invalid(`Component ${childId} has multiple parents`)
      }
      parentById.set(childId, component.id)
      byId.get(component.id).childIds.push(childId)
    }
  }

  for (const [childId, parentId] of parentById) {
    const parent = byId.get(parentId)
    if (!parent.childIds.includes(childId)) parent.childIds.push(childId)
  }

  const visiting = new Set()
  const visited = new Set()
  const build = (id) => {
    if (visiting.has(id)) throw new Error("Surface component graph contains a cycle")
    if (visited.has(id)) return byId.get(id)
    visiting.add(id)
    const node = byId.get(id)
    node.children = node.childIds.map(build)
    visiting.delete(id)
    visited.add(id)
    return node
  }

  try {
    const roots = components.filter((component) => !parentById.has(component.id)).map((component) => build(component.id))
    if (roots.length === 0 || visited.size !== components.length) {
      return invalid("Surface component graph has no valid root")
    }
    const bindings = Array.isArray(spec.bindings) ? spec.bindings : []
    if (bindings.length > 64) return invalid("Surface contains too many bindings")
    const bindingIds = new Set()
    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || typeof binding.id !== "string" || bindingIds.has(binding.id)) {
        return invalid("Surface contains an invalid or duplicate binding")
      }
      bindingIds.add(binding.id)
      if (
        !binding.target ||
        typeof binding.target.componentId !== "string" ||
        !byId.has(binding.target.componentId) ||
        typeof binding.target.prop !== "string" ||
        !binding.source ||
        !APPROVED_BINDING_KINDS.has(binding.source.kind) ||
        (binding.source.resourceId === undefined && binding.source.query === undefined) ||
        !boundedValue(binding.source)
      ) {
        return invalid(`Binding ${binding.id} is outside the approved contract`)
      }
    }
    return {
      ok: true,
      roots,
      bindings,
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid component graph")
  }
}

function invalid(error) {
  return { ok: false, error }
}

export function surfaceDisplayText(value, fields, fallback = "") {
  if (!value || typeof value !== "object") return fallback
  for (const field of fields) {
    const candidate = value[field]
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return fallback
}

export function projectSurfaceProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const provenance = /** @type {Record<string, any>} */ (value)
  const projected = {}
  for (const key of ["source", "actor_ref", "model", "profile", "run_id", "message_id", "prompt_hash", "note"]) {
    if (typeof provenance[key] === "string" && provenance[key].length <= 2_000) {
      projected[key] = provenance[key]
    }
  }
  for (const key of ["evidence_refs", "ham_refs"]) {
    if (Array.isArray(provenance[key])) {
      projected[key] = provenance[key]
        .filter((item) => typeof item === "string" && item.length <= 200)
        .slice(0, 100)
    }
  }
  if (provenance.galaxy && typeof provenance.galaxy === "object" && !Array.isArray(provenance.galaxy)) {
    projected.galaxy = Object.fromEntries(
      ["event", "principal_kind", "recorded_at"]
        .filter((key) => typeof provenance.galaxy[key] === "string")
        .map((key) => [key, provenance.galaxy[key]]),
    )
  }
  return projected
}

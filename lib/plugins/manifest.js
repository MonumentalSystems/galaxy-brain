export const GALAXY_PLUGIN_SCHEMA_ID = "galaxy-plugin.v1"

export const PLUGIN_CONTRIBUTION_KINDS = Object.freeze([
  "commands",
  "sources",
  "transforms",
  "projectors",
  "surfaceRenderers",
  "agentTools",
  "routes",
  "ingestionPlans",
])

export const PLUGIN_REGISTRY_KINDS = Object.freeze([
  ...PLUGIN_CONTRIBUTION_KINDS,
  "connections",
])

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MANIFEST_KEYS = new Set(["schemaId", "id", "displayName", "version", "contributes", "connections"])
const FORBIDDEN_KEY_PATTERN = /(?:url|module|component|script|code|handler|function|import|export)/i

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function diagnostic(code, path, message) {
  return Object.freeze({ code, path, message })
}

function inspectIdList(value, path, diagnostics) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("invalid_id_list", path, `${path} must be an array of registered IDs`))
    return []
  }

  const seen = new Set()
  const ids = []
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index]
    const itemPath = `${path}[${index}]`
    if (typeof id !== "string" || id.length > 128 || !ID_PATTERN.test(id)) {
      diagnostics.push(diagnostic("invalid_id", itemPath, `${itemPath} must be a stable registered ID`))
      continue
    }
    if (seen.has(id)) {
      diagnostics.push(diagnostic("duplicate_id", itemPath, `${path} contains duplicate ID ${id}`))
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids.sort()
}

function freezeManifest(manifest) {
  for (const kind of PLUGIN_CONTRIBUTION_KINDS) Object.freeze(manifest.contributes[kind])
  Object.freeze(manifest.contributes)
  Object.freeze(manifest.connections)
  return Object.freeze(manifest)
}

/** Return deterministic diagnostics and a canonical manifest when valid. */
export function inspectPluginManifest(input) {
  const diagnostics = []
  if (!isPlainObject(input)) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [diagnostic("invalid_manifest", "$", "Plugin manifest must be a plain data object")],
    }
  }

  for (const key of Object.keys(input).sort()) {
    if (!MANIFEST_KEYS.has(key)) {
      const code = FORBIDDEN_KEY_PATTERN.test(key) ? "forbidden_manifest_field" : "unknown_manifest_field"
      diagnostics.push(diagnostic(code, `$.${key}`, `Manifest field ${key} is not part of ${GALAXY_PLUGIN_SCHEMA_ID}`))
    }
  }

  if (input.schemaId !== GALAXY_PLUGIN_SCHEMA_ID) {
    diagnostics.push(diagnostic(
      "unsupported_schema",
      "$.schemaId",
      `Expected schemaId ${GALAXY_PLUGIN_SCHEMA_ID}`,
    ))
  }
  if (typeof input.id !== "string" || input.id.length > 128 || !ID_PATTERN.test(input.id)) {
    diagnostics.push(diagnostic("invalid_plugin_id", "$.id", "Plugin id must be a stable registered ID"))
  }
  if (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) {
    diagnostics.push(diagnostic("invalid_plugin_version", "$.version", "Plugin version must be semantic version text"))
  }
  if (input.displayName !== undefined && (
    typeof input.displayName !== "string" || input.displayName.trim().length === 0 || input.displayName.length > 120
  )) {
    diagnostics.push(diagnostic("invalid_display_name", "$.displayName", "displayName must be non-empty text"))
  }

  const contributes = {}
  if (!isPlainObject(input.contributes)) {
    diagnostics.push(diagnostic("invalid_contributions", "$.contributes", "contributes must be a plain data object"))
    for (const kind of PLUGIN_CONTRIBUTION_KINDS) contributes[kind] = []
  } else {
    for (const key of Object.keys(input.contributes).sort()) {
      if (!PLUGIN_CONTRIBUTION_KINDS.includes(key)) {
        const code = FORBIDDEN_KEY_PATTERN.test(key) ? "forbidden_manifest_field" : "unknown_contribution_kind"
        diagnostics.push(diagnostic(code, `$.contributes.${key}`, `Unknown contribution kind ${key}`))
      }
    }
    for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
      contributes[kind] = inspectIdList(input.contributes[kind], `$.contributes.${kind}`, diagnostics)
    }
  }
  const connections = inspectIdList(input.connections, "$.connections", diagnostics)

  if (diagnostics.length > 0) return { ok: false, manifest: null, diagnostics: Object.freeze(diagnostics) }

  return {
    ok: true,
    diagnostics: Object.freeze([]),
    manifest: freezeManifest({
      schemaId: GALAXY_PLUGIN_SCHEMA_ID,
      id: input.id,
      displayName: input.displayName?.trim() || input.id,
      version: input.version,
      contributes,
      connections,
    }),
  }
}

export class PluginManifestValidationError extends TypeError {
  constructor(diagnostics) {
    super(diagnostics.map((item) => `${item.code} at ${item.path}: ${item.message}`).join("; "))
    this.name = "PluginManifestValidationError"
    this.diagnostics = diagnostics
  }
}

export function validatePluginManifest(input) {
  const result = inspectPluginManifest(input)
  if (!result.ok) throw new PluginManifestValidationError(result.diagnostics)
  return result.manifest
}

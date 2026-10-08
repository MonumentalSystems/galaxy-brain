import {
  PLUGIN_REGISTRY_KINDS,
  PluginManifestValidationError,
  validatePluginManifest,
} from "./manifest.js"

const HANDLER_KEYS = new Set(["kind", "implementationId"])
const IMPLEMENTATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function diagnostic(code, path, message) {
  return Object.freeze({ code, path, message })
}

function validateHandlerDescriptor(value, kind, id, path, diagnostics) {
  if (!isPlainObject(value)) {
    diagnostics.push(diagnostic("invalid_handler", path, `Handler ${id} must be a code-owned descriptor`))
    return null
  }
  const extraKeys = Object.keys(value).filter((key) => !HANDLER_KEYS.has(key)).sort()
  for (const key of extraKeys) {
    diagnostics.push(diagnostic(
      "forbidden_handler_field",
      `${path}.${key}`,
      `Handler descriptors cannot register ${key}`,
    ))
  }
  if (value.kind !== kind) {
    diagnostics.push(diagnostic("handler_kind_mismatch", `${path}.kind`, `Handler ${id} must have kind ${kind}`))
  }
  if (
    typeof value.implementationId !== "string"
    || value.implementationId.length > 128
    || !IMPLEMENTATION_ID_PATTERN.test(value.implementationId)
  ) {
    diagnostics.push(diagnostic(
      "invalid_implementation_id",
      `${path}.implementationId`,
      `Handler ${id} must select a registered implementation ID`,
    ))
  }
  if (extraKeys.length > 0 || value.kind !== kind || typeof value.implementationId !== "string"
    || !IMPLEMENTATION_ID_PATTERN.test(value.implementationId)) return null
  return Object.freeze({ kind, implementationId: value.implementationId })
}

export class PluginRegistryValidationError extends TypeError {
  constructor(diagnostics) {
    super(diagnostics.map((item) => `${item.code} at ${item.path}: ${item.message}`).join("; "))
    this.name = "PluginRegistryValidationError"
    this.diagnostics = diagnostics
  }
}

/**
 * Build an immutable registry from code-owned packages.
 *
 * There is deliberately no register() method. A manifest can only reference
 * handler descriptors supplied in the same source-controlled package.
 */
export function createPluginRegistry(packages) {
  if (!Array.isArray(packages)) {
    throw new PluginRegistryValidationError([
      diagnostic("invalid_plugin_packages", "$", "Plugin packages must be an array"),
    ])
  }

  const diagnostics = []
  const plugins = new Map()
  const contributions = new Map(PLUGIN_REGISTRY_KINDS.map((kind) => [kind, new Map()]))

  for (let index = 0; index < packages.length; index += 1) {
    const pluginPackage = packages[index]
    const packagePath = `$[${index}]`
    if (!isPlainObject(pluginPackage)) {
      diagnostics.push(diagnostic("invalid_plugin_package", packagePath, "Plugin package must be a plain object"))
      continue
    }

    let manifest
    try {
      manifest = validatePluginManifest(pluginPackage.manifest)
    } catch (error) {
      if (error instanceof PluginManifestValidationError) {
        for (const item of error.diagnostics) {
          diagnostics.push(diagnostic(item.code, `${packagePath}.manifest${item.path.slice(1)}`, item.message))
        }
        continue
      }
      throw error
    }

    if (plugins.has(manifest.id)) {
      diagnostics.push(diagnostic(
        "duplicate_plugin_id",
        `${packagePath}.manifest.id`,
        `Plugin ID ${manifest.id} is already registered`,
      ))
      continue
    }

    const handlers = isPlainObject(pluginPackage.handlers) ? pluginPackage.handlers : {}
    if (!isPlainObject(pluginPackage.handlers)) {
      diagnostics.push(diagnostic("invalid_handlers", `${packagePath}.handlers`, "handlers must be a plain object"))
    }
    const resolvedHandlers = {}

    for (const kind of PLUGIN_REGISTRY_KINDS) {
      const ids = kind === "connections" ? manifest.connections : manifest.contributes[kind]
      const handlerMap = isPlainObject(handlers[kind]) ? handlers[kind] : {}
      resolvedHandlers[kind] = {}
      for (const id of ids) {
        const contributionPath = `${packagePath}.manifest.${kind === "connections" ? "connections" : `contributes.${kind}`}`
        if (!Object.hasOwn(handlerMap, id)) {
          diagnostics.push(diagnostic(
            "missing_handler",
            contributionPath,
            `${kind} contribution ${id} has no registered handler`,
          ))
          continue
        }
        const existing = contributions.get(kind).get(id)
        if (existing) {
          diagnostics.push(diagnostic(
            "duplicate_contribution_id",
            contributionPath,
            `${kind} contribution ${id} is already owned by ${existing.pluginId}`,
          ))
          continue
        }
        const descriptor = validateHandlerDescriptor(
          handlerMap[id],
          kind,
          id,
          `${packagePath}.handlers.${kind}.${id}`,
          diagnostics,
        )
        if (!descriptor) continue
        const registration = Object.freeze({ pluginId: manifest.id, id, handler: descriptor })
        resolvedHandlers[kind][id] = descriptor
        contributions.get(kind).set(id, registration)
      }
      Object.freeze(resolvedHandlers[kind])
    }
    Object.freeze(resolvedHandlers)
    plugins.set(manifest.id, Object.freeze({ manifest, handlers: resolvedHandlers }))
  }

  if (diagnostics.length > 0) throw new PluginRegistryValidationError(Object.freeze(diagnostics))

  const orderedPlugins = Object.freeze([...plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)))
  return Object.freeze({
    getPlugin(id) {
      return plugins.get(id) || null
    },
    listPlugins() {
      return [...orderedPlugins]
    },
    resolve(kind, id) {
      if (!PLUGIN_REGISTRY_KINDS.includes(kind)) return null
      return contributions.get(kind).get(id) || null
    },
    listContributions(kind) {
      if (!PLUGIN_REGISTRY_KINDS.includes(kind)) return []
      return [...contributions.get(kind).values()].sort((a, b) => a.id.localeCompare(b.id))
    },
  })
}

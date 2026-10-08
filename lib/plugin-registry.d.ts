export type PluginDefinition = {
  id: string
  displayName: string
  capabilities: readonly PluginCapability[]
  /** Env var holding the upstream base URL. */
  baseUrlEnv: string
  /** Fallback base URL for local development. */
  defaultBaseUrl: string
  /** Env var holding the upstream bearer token, when the service needs one. */
  tokenEnv?: string
  /** Methods this plugin accepts through the proxy. */
  methods: readonly string[]
}

export type PluginCapability = "source" | "transform" | "executor" | "projector" | "surface" | "sink"

export type ServiceTransformPluginDefinition = {
  id: "markitdown"
  displayName: string
  capabilities: readonly PluginCapability[]
  transport: "service"
  baseUrlEnv: string
  defaultBaseUrl: string
  tokenEnv: string
  tokenHeader: string
  endpoint: string
  output: "markdown"
  fidelity: "flat"
}

export type StructuredTransformPluginDefinition = {
  id: "docling"
  displayName: string
  capabilities: readonly PluginCapability[]
  transport: "service"
  baseUrlEnv: string
  defaultBaseUrl: ""
  tokenEnv: string
  tokenHeader: "X-API-Key"
  endpoint: "v1/convert/file"
  maxFileBytes: number
  output: "document-structure"
  fidelity: "structured"
}

export type LocalTransformPluginDefinition = {
  id: "plain-text"
  displayName: string
  capabilities: readonly PluginCapability[]
  transport: "local"
  output: "markdown"
  fidelity: "verbatim"
}

export type TransformPluginDefinition =
  | StructuredTransformPluginDefinition
  | ServiceTransformPluginDefinition
  | LocalTransformPluginDefinition

export const PLUGIN_CAPABILITIES: readonly PluginCapability[]

export function getPluginDefinition(id: string): PluginDefinition | null
export function listPluginDefinitions(): PluginDefinition[]
export function getTransformPluginDefinition(id: string): TransformPluginDefinition | null
export function listTransformPluginDefinitions(): TransformPluginDefinition[]
export function pluginBaseUrl(
  plugin: PluginDefinition | StructuredTransformPluginDefinition | ServiceTransformPluginDefinition,
): string
export function isSafePluginPath(path: string[]): boolean
export function pluginScopes(pluginId: string): string[]

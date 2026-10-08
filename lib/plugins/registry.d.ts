import type {
  GalaxyPluginManifest,
  PluginDiagnostic,
  PluginRegistryKind,
} from "./manifest.js"

export type PluginHandlerDescriptor = {
  kind: PluginRegistryKind
  implementationId: string
}

export type PluginHandlers = Partial<Record<PluginRegistryKind, Readonly<Record<string, PluginHandlerDescriptor>>>>

export type GalaxyPluginPackage = {
  manifest: unknown
  handlers: PluginHandlers
}

export type RegisteredPlugin = {
  manifest: GalaxyPluginManifest
  handlers: Readonly<Record<PluginRegistryKind, Readonly<Record<string, PluginHandlerDescriptor>>>>
}

export type RegisteredContribution = {
  pluginId: string
  id: string
  handler: PluginHandlerDescriptor
}

export type GalaxyPluginRegistry = {
  getPlugin(id: string): RegisteredPlugin | null
  listPlugins(): RegisteredPlugin[]
  resolve(kind: PluginRegistryKind, id: string): RegisteredContribution | null
  listContributions(kind: PluginRegistryKind): RegisteredContribution[]
}

export class PluginRegistryValidationError extends TypeError {
  diagnostics: readonly PluginDiagnostic[]
  constructor(diagnostics: readonly PluginDiagnostic[])
}

export function createPluginRegistry(packages: readonly GalaxyPluginPackage[]): GalaxyPluginRegistry

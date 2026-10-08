export type PluginContributionKind =
  | "commands"
  | "sources"
  | "transforms"
  | "projectors"
  | "surfaceRenderers"
  | "agentTools"
  | "routes"
  | "ingestionPlans"

export type PluginRegistryKind = PluginContributionKind | "connections"

export type GalaxyPluginManifest = {
  schemaId: "galaxy-plugin.v1"
  id: string
  displayName: string
  version: string
  contributes: Readonly<Record<PluginContributionKind, readonly string[]>>
  connections: readonly string[]
}

export type PluginDiagnostic = {
  code: string
  path: string
  message: string
}

export type PluginManifestInspection =
  | { ok: true; manifest: GalaxyPluginManifest; diagnostics: readonly [] }
  | { ok: false; manifest: null; diagnostics: readonly PluginDiagnostic[] }

export const GALAXY_PLUGIN_SCHEMA_ID: "galaxy-plugin.v1"
export const PLUGIN_CONTRIBUTION_KINDS: readonly PluginContributionKind[]
export const PLUGIN_REGISTRY_KINDS: readonly PluginRegistryKind[]

export class PluginManifestValidationError extends TypeError {
  diagnostics: readonly PluginDiagnostic[]
  constructor(diagnostics: readonly PluginDiagnostic[])
}

export function inspectPluginManifest(input: unknown): PluginManifestInspection
export function validatePluginManifest(input: unknown): GalaxyPluginManifest

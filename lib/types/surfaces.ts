export type SurfaceStatus = "draft" | "promoted" | "archived"

export interface GalaxySurfaceContractManifest {
  format: "galaxy.surface-contract"
  manifestVersion: 1
  schema: { id: "gb.surface.v1" }
  catalog: {
    id: "generous.a2ui"
    version: "1"
    renderer: { id: "generous-works"; version: string }
  }
  digests: {
    algorithm: "sha256"
    schema: string
    catalog: string
  }
}

export type SurfaceComponentType =
  | "Badge"
  | "Card"
  | "Charts"
  | "Column"
  | "DataTable"
  | "Grid"
  | "Heading"
  | "KnowledgeGraph"
  | "Markdown"
  | "Row"
  | "Separator"
  | "Stack"
  | "StatsDisplay"
  | "SVGPreview"
  | "Text"
  | "Timeline"
  | "Title"

export interface SurfaceComponent {
  id: string
  component: Partial<Record<SurfaceComponentType, Record<string, unknown>>>
  parentId?: string
  children?: string[]
}

export interface SurfaceBinding {
  id: string
  target: {
    componentId: string
    prop: string
  }
  source: {
    kind: "galaxy.eln.experiment" | "galaxy.eln.hypothesis" | "galaxy.ham.task"
    [key: string]: unknown
  }
}

export interface GalaxySurfaceSpec {
  schema: "gb.surface.v1"
  catalog: {
    id: "generous.a2ui"
    version: "1"
  }
  surfaceUpdate: {
    surfaceId?: string
    components: SurfaceComponent[]
  }
  bindings: SurfaceBinding[]
}

export interface GalaxySurfaceRecord {
  id: string
  tenant_id: string
  created_by_principal_id: string
  title: string
  status: SurfaceStatus
  schema_version: "gb.surface.v1"
  schema_digest: string
  catalog_id: "generous.a2ui"
  catalog_version: "1"
  catalog_digest: string
  renderer_version: string
  current_version: number
  current_content_hash: string
  current_spec: GalaxySurfaceSpec
  provenance: Record<string, unknown>
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface GalaxySurfaceRevision {
  id: string
  tenant_id: string
  surface_id: string
  version: number
  title: string
  status: SurfaceStatus
  schema_digest: string
  catalog_digest: string
  renderer_version: string
  content_hash: string
  spec: GalaxySurfaceSpec
  provenance: Record<string, unknown>
  created_by_principal_id: string
  created_at: string
}

export interface SurfaceBindingResolution {
  binding_id: string
  target: SurfaceBinding["target"]
  source_kind: SurfaceBinding["source"]["kind"]
  status: "resolved" | "error"
  resolved_at: string
  source_ids?: string[]
  source_revisions?: string[]
  freshness?: string | null
  error?: string
}

export interface ResolvedGalaxySurface {
  surface_id: string
  version: number
  definition_content_hash: string
  schema_digest: string
  catalog_digest: string
  renderer_version: string
  definition: GalaxySurfaceSpec
  materialized_spec: GalaxySurfaceSpec
  bindings: SurfaceBindingResolution[]
  resolved_at: string
}

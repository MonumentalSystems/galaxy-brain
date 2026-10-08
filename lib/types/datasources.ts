export type DatasourcePluginKind = "filesystem" | "cloud" | "api" | "reference"
export type DatasourcePluginAuthType = "none" | "path" | "token" | "oauth"
export type DatasourcePluginCapability = "list" | "fetch" | "sync" | "watch"
export type DatasourceConnectionStatus = "active" | "paused" | "error"

export interface DatasourcePluginManifest {
  id: string
  display_name: string
  kind: DatasourcePluginKind
  capabilities: DatasourcePluginCapability[]
  auth_type: DatasourcePluginAuthType
  is_builtin: boolean
  created_at?: string
  updated_at?: string
}

export interface DatasourceConnection {
  id: string
  plugin_id: string
  display_name: string
  status: DatasourceConnectionStatus
  root_path?: string | null
  config: Record<string, unknown>
  last_sync_cursor?: string | null
  last_synced_at?: string | null
  last_error?: string | null
  created_at: string
  updated_at: string
  plugin_display_name?: string
  plugin_kind?: DatasourcePluginKind
  plugin_capabilities?: DatasourcePluginCapability[]
}

export interface CreateDatasourceConnectionInput {
  plugin_id: string
  display_name: string
  root_path?: string
  config?: Record<string, unknown>
}

export interface UpdateDatasourceConnectionInput {
  display_name?: string
  status?: DatasourceConnectionStatus
  root_path?: string
  config?: Record<string, unknown>
  last_sync_cursor?: string
  last_error?: string
}

export interface DatasourceSyncRun {
  id: string
  connection_id: string
  status: "running" | "completed" | "failed"
  imported_count: number
  next_cursor?: string | null
  started_at: string
  completed_at?: string | null
  error_message?: string | null
}

export interface DatasourceSyncResponse {
  connection: DatasourceConnection
  sync_run: DatasourceSyncRun
  message: string
  inventory_truncated: boolean
}

export interface DatasourceItem {
  id: string
  title: string
  path?: string | null
  mime_type?: string | null
  updated_at?: string | null
  size?: number | null
}

export interface DatasourceItemsResponse {
  connection: DatasourceConnection
  items: DatasourceItem[]
  count: number
  truncated: boolean
}

export interface ImportedDatasourceItem extends DatasourceItem {
  content: string
  warnings?: string[]
}

export interface DatasourceImportResponse {
  connection: DatasourceConnection
  items: ImportedDatasourceItem[]
  count: number
}

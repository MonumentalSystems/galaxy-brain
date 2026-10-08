import type { DatasourceConnection, DatasourceItem } from "./types/datasources"
import type { GalaxyPluginRegistry } from "./plugins/registry.js"

export const MAX_DATASOURCE_ITEM_ID_CHARACTERS: number
export const MAX_DATASOURCE_CONTENT_REQUEST_BYTES: number
export const MAX_DATASOURCE_SOURCE_URI_CHARACTERS: number
export const DATASOURCE_FILE_SOURCE_ID: "datasource.connected"
export const DATASOURCE_FILE_SOURCE_IMPLEMENTATION_ID: "builtin.datasource.connected-source"
export const DATASOURCE_FILE_INGESTION_PLAN_ID: "datasource.file-default"
export function datasourceFileIngestionRegistered(registry?: GalaxyPluginRegistry): boolean
export function datasourceContentRequestBody(itemId: string): string
export function datasourceImportFilename(item: DatasourceItem): string
export function datasourceDurableImportUnavailableReason(item: DatasourceItem, connection: DatasourceConnection): string | null
export function datasourceSourceUri(connection: DatasourceConnection, item: DatasourceItem): string
export function datasourceImportTitle(item: DatasourceItem): string

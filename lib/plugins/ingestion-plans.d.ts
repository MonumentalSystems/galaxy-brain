import type { DocumentTransformResult } from "../document-transform-client.js"
import type { DurableDocumentImport, DurableDocumentImportMetadata } from "../durable-document-import.js"
import type { ConfirmedDocumentImport } from "../galaxy-brain-api.js"
import type { GalaxyPluginRegistry } from "./registry.js"

export const INGESTION_PLAN_SCHEMA_ID: "gb.ingestion-plan.v1"
export const INGESTION_PLAN_RESULT_SCHEMA_ID: "gb.ingestion-plan-result.v1"

export type IngestionPlanDefinition = Readonly<{
  schemaId: "gb.ingestion-plan.v1"
  id: string
  version: string
  owner: Readonly<{ pluginId: string; pluginVersion: string }>
  implementationId: string
  source: Readonly<{ contributionId: string; implementationId: string }>
  persist: Readonly<{ routeId: string; implementationId: string; originalRequired: true }>
  transformPolicy: Readonly<{
    implementationId: string
    transforms: readonly Readonly<{ contributionId: string; implementationId: string }>[]
  }>
  output: Readonly<{ kind: "document"; revisionPolicy: "pinned" }>
  contentSha256: string
}>

export class IngestionPlanContractError extends TypeError {
  code: string
}

export function canonicalIngestionPlanJson(value: unknown): string
export function ingestionPlanContentSha256(value: unknown): Promise<string>
export function validateIngestionPlanDefinition(value: unknown): IngestionPlanDefinition
export function verifyIngestionPlanDefinition(value: unknown): Promise<IngestionPlanDefinition>
export function resolveIngestionPlanDefinition(id: string, registry?: GalaxyPluginRegistry): IngestionPlanDefinition | null
export function listIngestionPlanDefinitions(registry?: GalaxyPluginRegistry): IngestionPlanDefinition[]
export function ingestionPlanExpectedSourceKind(value: unknown): "upload" | "url" | "arxiv" | "datasource"
export function ingestionPlanTransformScope(plan: unknown, document: unknown, scopePrefix?: string | null): string

export type IngestionPlanExecutionResult = Readonly<{
  schemaId: "gb.ingestion-plan-result.v1"
  plan: Readonly<{ id: string; version: string; contentSha256: string }>
  status: "persisted" | "transforming" | "complete"
  confirmation: Readonly<{ document: Readonly<DurableDocumentImport>; placementOperationId: string }>
  transform: DocumentTransformResult | null
  derivation: Readonly<{
    status: "failed" | "running" | "complete"
    code?: string
    retryable?: boolean
    receiptStatus?: "success" | "partial" | "fallback" | "failed" | "skipped"
  }>
}>

export function executeIngestionPlan(
  planId: string,
  request: {
    file: File
    metadata: DurableDocumentImportMetadata
    signal?: AbortSignal
    scopePrefix?: string
  },
  ports: {
    registry?: GalaxyPluginRegistry
    importDocument: (file: File, metadata: DurableDocumentImportMetadata, signal?: AbortSignal) => Promise<ConfirmedDocumentImport>
    transformDocument: (
      revisionId: string,
      options: { scope: string; signal?: AbortSignal },
    ) => Promise<DocumentTransformResult>
  },
): Promise<IngestionPlanExecutionResult>

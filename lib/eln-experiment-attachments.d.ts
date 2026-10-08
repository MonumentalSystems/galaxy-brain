import type { ConfirmedDocumentImport } from "./galaxy-brain-api"

export interface ConfirmedAttachmentRetry {
  readonly documentRef: string
  readonly idempotencyKey: string
  readonly title: string
}

export function exactAttachmentDocumentRef(value: unknown): {
  ref: string
  revisionSha256: string
}
export function experimentAttachmentOperationKey(experimentId: string, documentRef: string): Promise<string>
export function confirmedAttachmentRetry(
  confirmed: ConfirmedDocumentImport,
  idempotencyKey: string,
): ConfirmedAttachmentRetry

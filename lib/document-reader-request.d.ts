export type DocumentReaderRequestIdentityInput = {
  documentRevisionId: string
  tenantId: string
  principalId: string
}

export type DocumentReaderCompletion = {
  active: boolean
  aborted: boolean
  generation: number
  identityKey: string
}

export type CurrentDocumentReaderRequest = {
  generation: number
  identityKey: string
}

export function documentReaderRequestIdentity(input: DocumentReaderRequestIdentityInput): string
export function shouldAcceptDocumentReaderCompletion(
  request: DocumentReaderCompletion,
  current: CurrentDocumentReaderRequest,
): boolean

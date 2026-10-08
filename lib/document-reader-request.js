const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

function identityPart(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || Array.from(value).length > 1024
    || CONTROL.test(value)
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

/** Collision-safe identity for every authority input that can change a reader request. */
export function documentReaderRequestIdentity({ documentRevisionId, tenantId, principalId }) {
  return JSON.stringify([
    identityPart(documentRevisionId, "Document revision"),
    identityPart(tenantId, "Tenant"),
    identityPart(principalId, "Principal"),
  ])
}

/**
 * A completion is authoritative only while its exact effect instance and
 * synchronous render identity remain current.
 */
export function shouldAcceptDocumentReaderCompletion(request, current) {
  return request?.active === true
    && request.aborted === false
    && Number.isSafeInteger(request.generation)
    && request.generation > 0
    && request.generation === current?.generation
    && request.identityKey === current?.identityKey
}

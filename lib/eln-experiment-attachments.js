const PINNED_DOCUMENT_REF = /^gb:object:v1:document:[0-9a-f-]{36}:pinned:sha256%3A([0-9a-f]{64})$/u

export function exactAttachmentDocumentRef(value) {
  if (typeof value !== "string" || value.length > 800) {
    throw new TypeError("A bounded pinned document reference is required")
  }
  const match = PINNED_DOCUMENT_REF.exec(value)
  if (!match) throw new TypeError("A canonical pinned document reference is required")
  return { ref: value, revisionSha256: match[1] }
}

export async function experimentAttachmentOperationKey(experimentId, documentRef) {
  if (typeof experimentId !== "string" || !experimentId || experimentId.length > 200) {
    throw new TypeError("A bounded experiment identity is required")
  }
  const exact = exactAttachmentDocumentRef(documentRef)
  const bytes = new TextEncoder().encode(`${experimentId}\n${exact.ref}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return `eln.attachment.${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function confirmedAttachmentRetry(confirmed, idempotencyKey) {
  const exact = exactAttachmentDocumentRef(confirmed?.document?.ref)
  if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(idempotencyKey)) {
    throw new TypeError("A valid attachment operation key is required")
  }
  return Object.freeze({
    documentRef: exact.ref,
    idempotencyKey,
    title: String(confirmed.document.title || "Document").slice(0, 500),
  })
}

import {
  captureIntentSha256,
  captureToDocumentSource,
  parseCaptureIdempotencyKey,
} from "./capture-contract.js"
import { executeIngestionPlan } from "./plugins/ingestion-plans.js"

export const WEB_CAPTURE_RESULT_SCHEMA_ID = "gb.web-capture.result.v1"
export const WEB_CAPTURE_PLAN_ID = "web.capture-default"

function requiredPort(value, label) {
  if (typeof value !== "function") throw new TypeError(`Web capture requires ${label}`)
  return value
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/**
 * Execute caller-supplied web bytes through the same immutable ingestion plan
 * used by other document sources. This function never fetches capture.url.
 * HAM is an optional mirror after Galaxy has confirmed durable persistence.
 */
export async function executeWebCaptureIngestion(request, ports) {
  const capture = request?.capture
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    throw new TypeError("Web capture requires a validated capture")
  }
  const idempotencyKey = parseCaptureIdempotencyKey(request.idempotencyKey)
  const persistOriginal = requiredPort(ports?.persistOriginal, "a durable original port")
  const transformDocument = requiredPort(ports?.transformDocument, "a document transform port")
  const source = captureToDocumentSource(capture)
  const intentSha256 = await captureIntentSha256(capture)
  const file = Object.freeze({
    name: source.filename,
    size: source.bytes.byteLength,
    type: source.mediaType,
    arrayBuffer: async () => exactArrayBuffer(source.bytes),
  })

  const ingestion = await executeIngestionPlan(WEB_CAPTURE_PLAN_ID, {
    file,
    metadata: Object.freeze({
      title: capture.title,
      filename: source.filename,
      sourceKind: "url",
      sourceUri: capture.url,
      arxivId: null,
      captureIntentSha256: intentSha256,
    }),
    scopePrefix: `web-capture:${idempotencyKey}`,
  }, {
    importDocument: async (_file, metadata) => {
      const document = await persistOriginal(Object.freeze({
        bytes: source.bytes,
        mediaType: source.mediaType,
        filename: source.filename,
        metadata,
        idempotencyKey: `web-capture:${idempotencyKey}`,
      }))
      return Object.freeze({ document, placementOperationId: `web-capture:${idempotencyKey}` })
    },
    transformDocument,
  })

  let mirror = Object.freeze({ status: "not-configured" })
  if (typeof ports?.mirrorCapture === "function") {
    try {
      const mirrored = await ports.mirrorCapture(capture)
      mirror = Object.freeze({
        status: "mirrored",
        id: typeof mirrored?.id === "string" || mirrored?.id === null ? mirrored.id : null,
      })
    } catch {
      mirror = Object.freeze({ status: "unavailable" })
    }
  }

  const legacyMirrorId = mirror.status === "mirrored" ? mirror.id ?? null : null
  return Object.freeze({
    schemaId: WEB_CAPTURE_RESULT_SCHEMA_ID,
    id: legacyMirrorId,
    title: capture.title,
    url: capture.url,
    capturedAt: capture.capturedAt,
    document: ingestion.confirmation.document,
    ingestion: Object.freeze({
      status: ingestion.status,
      plan: ingestion.plan,
      derivation: ingestion.derivation,
    }),
    transform: ingestion.transform,
    hamMirror: mirror,
  })
}

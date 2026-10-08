import { validateDocumentTransformResponse } from "../document-transform-client.js"
import { validateDurableDocumentImport } from "../durable-document-import.js"
import { builtinPluginRegistry } from "./builtins.js"

export const INGESTION_PLAN_SCHEMA_ID = "gb.ingestion-plan.v1"
export const INGESTION_PLAN_RESULT_SCHEMA_ID = "gb.ingestion-plan-result.v1"

const PLAN_KEYS = new Set([
  "schemaId", "id", "version", "owner", "implementationId", "source", "persist",
  "transformPolicy", "output", "contentSha256",
])
const OWNER_KEYS = new Set(["pluginId", "pluginVersion"])
const SOURCE_KEYS = new Set(["contributionId", "implementationId"])
const PERSIST_KEYS = new Set(["routeId", "implementationId", "originalRequired"])
const TRANSFORM_POLICY_KEYS = new Set(["implementationId", "transforms"])
const TRANSFORM_KEYS = new Set(["contributionId", "implementationId"])
const OUTPUT_KEYS = new Set(["kind", "revisionPolicy"])
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

const DOCUMENT_UPLOAD_DEFAULT = Object.freeze({
  schemaId: INGESTION_PLAN_SCHEMA_ID,
  id: "document.upload-default",
  version: "1.0.0",
  owner: Object.freeze({ pluginId: "documents", pluginVersion: "1.0.0" }),
  implementationId: "builtin.ingestion-plan.document-upload-default",
  source: Object.freeze({
    contributionId: "document.upload",
    implementationId: "builtin.document.upload-source",
  }),
  persist: Object.freeze({
    routeId: "document.import-route",
    implementationId: "builtin.document.import-route",
    originalRequired: true,
  }),
  transformPolicy: Object.freeze({
    implementationId: "builtin.document-transform-policy.structure-first-v1",
    transforms: Object.freeze([
      Object.freeze({ contributionId: "docling.convert", implementationId: "builtin.docling.convert" }),
      Object.freeze({ contributionId: "markitdown.convert", implementationId: "builtin.markitdown.convert" }),
      Object.freeze({ contributionId: "plain-text.convert", implementationId: "builtin.plain-text.convert" }),
    ]),
  }),
  output: Object.freeze({ kind: "document", revisionPolicy: "pinned" }),
  // SHA-256 of canonicalIngestionPlanJson(plan), excluding this field.
  contentSha256: "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
})

const DATASOURCE_FILE_DEFAULT = Object.freeze({
  schemaId: INGESTION_PLAN_SCHEMA_ID,
  id: "datasource.file-default",
  version: "1.0.0",
  owner: Object.freeze({ pluginId: "datasources", pluginVersion: "1.0.0" }),
  implementationId: "builtin.ingestion-plan.datasource-file-default",
  source: Object.freeze({
    contributionId: "datasource.connected",
    implementationId: "builtin.datasource.connected-source",
  }),
  persist: Object.freeze({
    routeId: "document.import-route",
    implementationId: "builtin.document.import-route",
    originalRequired: true,
  }),
  transformPolicy: Object.freeze({
    implementationId: "builtin.document-transform-policy.structure-first-v1",
    transforms: Object.freeze([
      Object.freeze({ contributionId: "docling.convert", implementationId: "builtin.docling.convert" }),
      Object.freeze({ contributionId: "markitdown.convert", implementationId: "builtin.markitdown.convert" }),
      Object.freeze({ contributionId: "plain-text.convert", implementationId: "builtin.plain-text.convert" }),
    ]),
  }),
  output: Object.freeze({ kind: "document", revisionPolicy: "pinned" }),
  // SHA-256 of canonicalIngestionPlanJson(plan), excluding this field.
  contentSha256: "e3f23ff9cfc350e5a29d3efb897b96bee480bae0375dba83bea1d15cfc5b68d3",
})

const WEB_CAPTURE_DEFAULT = Object.freeze({
  schemaId: INGESTION_PLAN_SCHEMA_ID,
  id: "web.capture-default",
  version: "1.0.0",
  owner: Object.freeze({ pluginId: "web-capture", pluginVersion: "1.0.0" }),
  implementationId: "builtin.ingestion-plan.web-capture-default",
  source: Object.freeze({
    contributionId: "web.capture",
    implementationId: "builtin.web.capture-source",
  }),
  persist: Object.freeze({
    routeId: "document.import-route",
    implementationId: "builtin.document.import-route",
    originalRequired: true,
  }),
  transformPolicy: Object.freeze({
    implementationId: "builtin.document-transform-policy.structure-first-v1",
    transforms: Object.freeze([
      Object.freeze({ contributionId: "docling.convert", implementationId: "builtin.docling.convert" }),
      Object.freeze({ contributionId: "markitdown.convert", implementationId: "builtin.markitdown.convert" }),
      Object.freeze({ contributionId: "plain-text.convert", implementationId: "builtin.plain-text.convert" }),
    ]),
  }),
  output: Object.freeze({ kind: "document", revisionPolicy: "pinned" }),
  // SHA-256 of canonicalIngestionPlanJson(plan), excluding this field.
  contentSha256: "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8",
})

const ARXIV_FETCH_DEFAULT = Object.freeze({
  schemaId: INGESTION_PLAN_SCHEMA_ID,
  id: "arxiv.fetch-default",
  version: "1.0.0",
  owner: Object.freeze({ pluginId: "papers", pluginVersion: "1.0.0" }),
  implementationId: "builtin.ingestion-plan.arxiv-fetch-default",
  source: Object.freeze({
    contributionId: "arxiv.pdf",
    implementationId: "builtin.arxiv.pdf-source",
  }),
  persist: Object.freeze({
    routeId: "arxiv.private-fetch-route",
    implementationId: "builtin.arxiv.private-fetch-route",
    originalRequired: true,
  }),
  transformPolicy: Object.freeze({
    implementationId: "builtin.document-transform-policy.structure-first-v1",
    transforms: Object.freeze([
      Object.freeze({ contributionId: "docling.convert", implementationId: "builtin.docling.convert" }),
      Object.freeze({ contributionId: "markitdown.convert", implementationId: "builtin.markitdown.convert" }),
      Object.freeze({ contributionId: "plain-text.convert", implementationId: "builtin.plain-text.convert" }),
    ]),
  }),
  output: Object.freeze({ kind: "document", revisionPolicy: "pinned" }),
  // SHA-256 of canonicalIngestionPlanJson(plan), excluding this field.
  contentSha256: "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a",
})

const CODE_OWNED_PLANS = Object.freeze({
  "builtin.ingestion-plan.document-upload-default": DOCUMENT_UPLOAD_DEFAULT,
  "builtin.ingestion-plan.datasource-file-default": DATASOURCE_FILE_DEFAULT,
  "builtin.ingestion-plan.web-capture-default": WEB_CAPTURE_DEFAULT,
  "builtin.ingestion-plan.arxiv-fetch-default": ARXIV_FETCH_DEFAULT,
})

const PLAN_SOURCE_KINDS = Object.freeze({
  "document.upload": "upload",
  "datasource.connected": "datasource",
  "web.capture": "url",
  "arxiv.pdf": "arxiv",
})

export class IngestionPlanContractError extends TypeError {
  constructor(code, message) {
    super(message)
    this.name = "IngestionPlanContractError"
    this.code = code
  }
}

function fail(code, message) {
  throw new IngestionPlanContractError(code, message)
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail("invalid-plan", `${label} must be a plain data object`)
  const extras = Object.keys(value).filter((key) => !allowed.has(key)).sort()
  if (extras.length > 0) fail("forbidden-plan-field", `${label} contains unsupported field ${extras[0]}`)
}

function stableId(value, label) {
  if (typeof value !== "string" || value.length > 128 || !ID_PATTERN.test(value)) {
    fail("invalid-plan", `${label} must be a stable registered ID`)
  }
  return value
}

function version(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail("invalid-plan", `${label} must be semantic version text`)
  }
  return value
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalIngestionPlanJson(value) {
  const plan = validateIngestionPlanDefinition(value)
  const { contentSha256: _contentSha256, ...payload } = plan
  return canonicalJson(payload)
}

export async function ingestionPlanContentSha256(value) {
  const bytes = new TextEncoder().encode(canonicalIngestionPlanJson(value))
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function validateIngestionPlanDefinition(value) {
  exactKeys(value, PLAN_KEYS, "Ingestion plan")
  if (value.schemaId !== INGESTION_PLAN_SCHEMA_ID) fail("unsupported-plan-schema", `Expected ${INGESTION_PLAN_SCHEMA_ID}`)
  const id = stableId(value.id, "Ingestion plan id")
  const planVersion = version(value.version, "Ingestion plan version")
  exactKeys(value.owner, OWNER_KEYS, "Ingestion plan owner")
  const pluginId = stableId(value.owner.pluginId, "Owner plugin id")
  const pluginVersion = version(value.owner.pluginVersion, "Owner plugin version")
  const implementationId = stableId(value.implementationId, "Ingestion plan implementation id")
  exactKeys(value.source, SOURCE_KEYS, "Ingestion plan source")
  const contributionId = stableId(value.source.contributionId, "Source contribution id")
  const sourceImplementationId = stableId(value.source.implementationId, "Source implementation id")
  exactKeys(value.persist, PERSIST_KEYS, "Ingestion plan persistence")
  const routeId = stableId(value.persist.routeId, "Persistence route id")
  const persistImplementationId = stableId(value.persist.implementationId, "Persistence implementation id")
  if (value.persist.originalRequired !== true) {
    fail("unsupported-plan-operation", "Ingestion plans must persist the exact original first")
  }
  exactKeys(value.transformPolicy, TRANSFORM_POLICY_KEYS, "Ingestion plan transform policy")
  const transformPolicyImplementationId = stableId(
    value.transformPolicy.implementationId,
    "Transform policy implementation id",
  )
  if (!Array.isArray(value.transformPolicy.transforms) || value.transformPolicy.transforms.length !== 3) {
    fail("invalid-plan", "Ingestion plan must declare the bounded transform contribution set")
  }
  const transforms = value.transformPolicy.transforms.map((transform, index) => {
    exactKeys(transform, TRANSFORM_KEYS, `Ingestion plan transform ${index}`)
    return Object.freeze({
      contributionId: stableId(transform.contributionId, `Transform ${index} contribution id`),
      implementationId: stableId(transform.implementationId, `Transform ${index} implementation id`),
    })
  })
  if (new Set(transforms.map((item) => item.contributionId)).size !== transforms.length) {
    fail("invalid-plan", "Ingestion plan transform contributions must be unique")
  }
  exactKeys(value.output, OUTPUT_KEYS, "Ingestion plan output")
  if (value.output.kind !== "document" || value.output.revisionPolicy !== "pinned") {
    fail("unsupported-plan-output", "Ingestion plan must return a pinned document revision")
  }
  if (typeof value.contentSha256 !== "string" || !SHA256_PATTERN.test(value.contentSha256)) {
    fail("invalid-plan-hash", "Ingestion plan contentSha256 must be a lowercase SHA-256")
  }
  return Object.freeze({
    schemaId: INGESTION_PLAN_SCHEMA_ID,
    id,
    version: planVersion,
    owner: Object.freeze({ pluginId, pluginVersion }),
    implementationId,
    source: Object.freeze({ contributionId, implementationId: sourceImplementationId }),
    persist: Object.freeze({
      routeId,
      implementationId: persistImplementationId,
      originalRequired: true,
    }),
    transformPolicy: Object.freeze({
      implementationId: transformPolicyImplementationId,
      transforms: Object.freeze(transforms),
    }),
    output: Object.freeze({ kind: "document", revisionPolicy: "pinned" }),
    contentSha256: value.contentSha256,
  })
}

export async function verifyIngestionPlanDefinition(value) {
  const plan = validateIngestionPlanDefinition(value)
  if (await ingestionPlanContentSha256(plan) !== plan.contentSha256) {
    fail("plan-hash-mismatch", "Ingestion plan content does not match its registered hash")
  }
  return plan
}

export function resolveIngestionPlanDefinition(id, registry = builtinPluginRegistry) {
  const registration = registry?.resolve?.("ingestionPlans", id)
  if (!registration) return null
  const definition = CODE_OWNED_PLANS[registration.handler.implementationId]
  if (!definition) fail("unknown-plan-implementation", "Ingestion plan implementation is not allowlisted")
  const plan = validateIngestionPlanDefinition(definition)
  const owner = registry.getPlugin?.(registration.pluginId)
  const sourceRegistration = registry.resolve("sources", plan.source.contributionId)
  const routeRegistration = registry.resolve("routes", plan.persist.routeId)
  const transformRegistrations = plan.transformPolicy.transforms.map((transform) => ({
    expected: transform,
    registration: registry.resolve("transforms", transform.contributionId),
  }))
  if (
    plan.id !== registration.id
    || plan.owner.pluginId !== registration.pluginId
    || plan.owner.pluginVersion !== owner?.manifest.version
    || plan.implementationId !== registration.handler.implementationId
    || sourceRegistration?.pluginId !== plan.owner.pluginId
    || sourceRegistration?.handler.implementationId !== plan.source.implementationId
    || routeRegistration?.handler.implementationId !== plan.persist.implementationId
    || transformRegistrations.some(
      ({ expected, registration: item }) => item?.handler.implementationId !== expected.implementationId,
    )
  ) {
    fail("plan-registry-drift", "Ingestion plan no longer matches its code-owned plugin registration")
  }
  return plan
}

export function listIngestionPlanDefinitions(registry = builtinPluginRegistry) {
  return registry.listContributions("ingestionPlans").map((item) => resolveIngestionPlanDefinition(item.id, registry))
}

export function ingestionPlanExpectedSourceKind(value) {
  const plan = validateIngestionPlanDefinition(value)
  const sourceKind = PLAN_SOURCE_KINDS[plan.source.contributionId]
  if (!sourceKind) fail("unknown-plan-source-kind", "Ingestion plan does not have a code-owned source-kind binding")
  return sourceKind
}

export function ingestionPlanTransformScope(plan, document, scopePrefix = null) {
  const exactPlan = validateIngestionPlanDefinition(plan)
  const exactDocument = validateDurableDocumentImport(document, { ingestionPlan: exactPlan })
  if (scopePrefix !== null && (
    typeof scopePrefix !== "string"
    || scopePrefix.length < 1
    || scopePrefix.length > 180
    || /[\u0000-\u001f\u007f-\u009f]/u.test(scopePrefix)
  )) fail("invalid-plan-scope", "Ingestion plan transform scope prefix is invalid")
  const scope = `${INGESTION_PLAN_SCHEMA_ID}:${exactPlan.id}@${exactPlan.version}:${exactPlan.contentSha256}:${exactDocument.document_id}:${exactDocument.revision_id}`
  return scopePrefix === null ? scope : `${scopePrefix}:${scope}`
}

function transformFailure(error) {
  const code = typeof error?.code === "string" && ID_PATTERN.test(error.code)
    ? error.code
    : "transform-unavailable"
  return Object.freeze({ status: "failed", code, retryable: error?.retryable === true })
}

export async function executeIngestionPlan(planId, request, ports) {
  const registered = resolveIngestionPlanDefinition(planId, ports?.registry ?? builtinPluginRegistry)
  if (!registered) fail("plan-not-found", "Ingestion plan is not registered")
  const plan = await verifyIngestionPlanDefinition(registered)
  if (!request || typeof request !== "object" || !request.file || !request.metadata) {
    fail("invalid-plan-request", "Ingestion plan requires one file and import metadata")
  }
  if ((request.metadata.sourceKind ?? "upload") !== ingestionPlanExpectedSourceKind(plan)) {
    fail("plan-source-kind-mismatch", "Ingestion plan cannot authorize this import source kind")
  }
  if (typeof ports?.importDocument !== "function" || typeof ports?.transformDocument !== "function") {
    fail("invalid-plan-port", "Ingestion plan requires the existing document import and transform APIs")
  }

  const ingestionPlan = Object.freeze({
    id: plan.id,
    version: plan.version,
    contentSha256: plan.contentSha256,
  })
  const rawConfirmation = await ports.importDocument(
    request.file,
    { ...request.metadata, ingestionPlan },
    request.signal,
  )
  const document = validateDurableDocumentImport(rawConfirmation?.document, { ingestionPlan: plan })
  if (
    typeof rawConfirmation?.placementOperationId !== "string"
    || rawConfirmation.placementOperationId.length < 1
    || rawConfirmation.placementOperationId.length > 200
  ) {
    fail("invalid-import-confirmation", "Document import returned an invalid confirmation")
  }
  const confirmation = Object.freeze({
    document,
    placementOperationId: rawConfirmation.placementOperationId,
  })
  const scope = ingestionPlanTransformScope(plan, document, request.scopePrefix ?? null)

  let transformed
  try {
    transformed = await ports.transformDocument(document.revision_id, { scope, signal: request.signal })
  } catch (error) {
    return Object.freeze({
      schemaId: INGESTION_PLAN_RESULT_SCHEMA_ID,
      plan: Object.freeze({ id: plan.id, version: plan.version, contentSha256: plan.contentSha256 }),
      status: "persisted",
      confirmation,
      transform: null,
      derivation: transformFailure(error),
    })
  }

  const transform = validateDocumentTransformResponse(transformed, document.revision_id)
  if (transform.status === "running") {
    return Object.freeze({
      schemaId: INGESTION_PLAN_RESULT_SCHEMA_ID,
      plan: Object.freeze({ id: plan.id, version: plan.version, contentSha256: plan.contentSha256 }),
      status: "transforming",
      confirmation,
      transform,
      derivation: Object.freeze({ status: "running" }),
    })
  }
  const successfulStatuses = new Set(["success", "partial", "fallback"])
  const effectiveReceipt = successfulStatuses.has(transform.receipt.status)
    ? transform.receipt
    : successfulStatuses.has(transform.fallbackReceipt?.status)
      ? transform.fallbackReceipt
      : transform.fallbackReceipt || transform.receipt
  const receiptStatus = effectiveReceipt.status
  if (!successfulStatuses.has(receiptStatus)) {
    return Object.freeze({
      schemaId: INGESTION_PLAN_RESULT_SCHEMA_ID,
      plan: Object.freeze({ id: plan.id, version: plan.version, contentSha256: plan.contentSha256 }),
      status: "persisted",
      confirmation,
      transform,
      derivation: Object.freeze({
        status: "failed",
        code: effectiveReceipt.diagnostic_code || `transform-${receiptStatus}`,
        retryable: false,
        receiptStatus,
      }),
    })
  }
  return Object.freeze({
    schemaId: INGESTION_PLAN_RESULT_SCHEMA_ID,
    plan: Object.freeze({ id: plan.id, version: plan.version, contentSha256: plan.contentSha256 }),
    status: "complete",
    confirmation,
    transform,
    derivation: Object.freeze({ status: "complete", receiptStatus }),
  })
}

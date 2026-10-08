import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"

const EXPERIMENT_ID = "30000000-0000-4000-8000-000000000001"
const OBSERVATION_ID = "40000000-0000-4000-8000-000000000001"
const OPERATION_ID = "50000000-0000-4000-8000-000000000001"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

async function clientHarness(responseFactory) {
  const source = await readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const requests = []
  const sandbox = {
    exports: {},
    AbortSignal,
    ArrayBuffer,
    Blob,
    Error,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    console,
    crypto: {
      randomUUID: () => OPERATION_ID,
      subtle: {
        digest: async (_algorithm, bytes) => {
          const digest = createHash("sha256").update(Buffer.from(bytes)).digest()
          return Uint8Array.from(digest).buffer
        },
      },
    },
    fetch: async (url, init) => {
      requests.push({ url, init })
      return Response.json(await responseFactory({ url, init }))
    },
    require(name) {
      if (name === "./galaxy-object-reference.js") {
        return { parseGalaxyObjectReference, serializeGalaxyObjectReference }
      }
      return new Proxy({}, { get: () => undefined })
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return { api: sandbox.exports.galaxyBrainAPI, ErrorType: sandbox.exports.GalaxyBrainAPIError, requests }
}

function receipt({ observedAt, requestSha256, revisionSha256 }) {
  return {
    schemaId: "gb.eln-observation-create-receipt.v1",
    experimentId: EXPERIMENT_ID,
    requestSha256,
    replayed: false,
    observation: {
      schemaId: "gb.eln-observation-ref.v1",
      id: OBSERVATION_ID,
      experimentId: EXPERIMENT_ID,
      ref: `gb:object:v1:eln.observation:${OBSERVATION_ID}:pinned:sha256%3A${revisionSha256}`,
      version: 1,
      revisionSha256,
      body: "Stable reading",
      observedAt,
      createdAt: "2026-09-28T16:30:01.000000Z",
      createdByPrincipalId: "20000000-0000-4000-8000-000000000001",
    },
  }
}

test("browser observation client verifies request hash, revision hash, and explicit normalized time", async () => {
  const requested = "2026-09-28T18:00:00+01:30"
  const normalized = "2026-09-28T16:30:00.000000Z"
  const requestHash = sha256(JSON.stringify({
    body: "Stable reading",
    experimentId: EXPERIMENT_ID,
    observedAt: normalized,
    schemaId: "gb.eln-observation-create.v1",
  }))
  const revisionHash = sha256(JSON.stringify({ body: "Stable reading", observedAt: normalized }))
  const harness = await clientHarness(() => receipt({
    observedAt: normalized,
    requestSha256: requestHash,
    revisionSha256: revisionHash,
  }))
  const result = await harness.api.createExperimentObservation(
    EXPERIMENT_ID,
    { body: "Stable reading", observedAt: requested },
    `eln-observation:${OPERATION_ID}`,
  )
  assert.equal(result.requestSha256, requestHash)
  assert.equal(result.observation.observedAt, normalized)
  assert.equal(JSON.parse(harness.requests[0].init.body).observedAt, normalized)
})

test("browser observation client rejects a receipt whose explicit time or hashes drift", async () => {
  const normalized = "2026-09-28T16:30:00.000000Z"
  const drifted = "2026-09-28T16:31:00.000000Z"
  const requestHash = sha256(JSON.stringify({
    body: "Stable reading",
    experimentId: EXPERIMENT_ID,
    observedAt: normalized,
    schemaId: "gb.eln-observation-create.v1",
  }))
  const driftedRevisionHash = sha256(JSON.stringify({ body: "Stable reading", observedAt: drifted }))
  const timeDrift = await clientHarness(() => receipt({
    observedAt: drifted,
    requestSha256: requestHash,
    revisionSha256: driftedRevisionHash,
  }))
  await assert.rejects(
    timeDrift.api.createExperimentObservation(
      EXPERIMENT_ID,
      { body: "Stable reading", observedAt: normalized },
      `eln-observation:${OPERATION_ID}`,
    ),
    (error) => error instanceof timeDrift.ErrorType && error.status === 502,
  )

  const badRequest = await clientHarness(() => receipt({
    observedAt: normalized,
    requestSha256: "0".repeat(64),
    revisionSha256: sha256(JSON.stringify({ body: "Stable reading", observedAt: normalized })),
  }))
  await assert.rejects(
    badRequest.api.createExperimentObservation(
      EXPERIMENT_ID,
      { body: "Stable reading", observedAt: normalized },
      `eln-observation:${OPERATION_ID}`,
    ),
    (error) => error instanceof badRequest.ErrorType && error.status === 502,
  )

  const defaultRequestHash = sha256(JSON.stringify({
    body: "Stable reading",
    experimentId: EXPERIMENT_ID,
    observedAt: null,
    schemaId: "gb.eln-observation-create.v1",
  }))
  const noncanonicalReceipt = await clientHarness(() => receipt({
    observedAt: "2026-09-28T16:30:00Z",
    requestSha256: defaultRequestHash,
    revisionSha256: sha256(JSON.stringify({
      body: "Stable reading", observedAt: "2026-09-28T16:30:00Z",
    })),
  }))
  await assert.rejects(
    noncanonicalReceipt.api.createExperimentObservation(
      EXPERIMENT_ID,
      { body: "Stable reading" },
      `eln-observation:${OPERATION_ID}`,
    ),
    (error) => error instanceof noncanonicalReceipt.ErrorType && error.status === 502,
  )
})

test("browser observation client rejects invalid and UTC-overflow RFC 3339 inputs with 422", async () => {
  const harness = await clientHarness(() => {
    throw new Error("invalid timestamps must not be sent")
  })
  for (const observedAt of [
    "20260928T163000Z",
    "2026-W40-1T16:30:00Z",
    "2026-09-28 16:30:00Z",
    "2026-09-28T16:30Z",
    "2026-09-28T16:30:00",
    "2026-09-28T16:30:00z",
    "2026-02-30T16:30:00Z",
    "2026-09-28T24:00:00Z",
    "2026-09-28T16:30:60Z",
    "2026-09-28T16:30:00+24:00",
    "0001-01-01T00:00:00+14:00",
    "9999-12-31T23:59:59-12:00",
  ]) {
    await assert.rejects(
      harness.api.createExperimentObservation(
        EXPERIMENT_ID,
        { body: "Stable reading", observedAt },
        `eln-observation:${OPERATION_ID}`,
      ),
      (error) => error instanceof harness.ErrorType && error.status === 422,
      observedAt,
    )
    assert.equal(harness.requests.length, 0)
  }
})

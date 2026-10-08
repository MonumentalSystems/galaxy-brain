import assert from "node:assert/strict"
import test from "node:test"

import {
  GALAXY_OBJECT_KINDS,
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  planGalaxyObjectResolution,
  selectGalaxyObjectResolver,
  serializeGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"

const domainKinds = [
  "paper",
  "document",
  "document.anchor",
  "document.mark",
  "eln.experiment",
  "eln.observation",
  "eln.hypothesis",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "chat",
  "run",
  "turn",
  "claim",
  "artifact",
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
  "proof.graph",
  "proof.node",
]

const scope = Object.freeze({ tenantId: "tenant-a", authorityScope: "principal:reader-a|grants:eln:read" })

test("every canonical domain kind round-trips latest and pinned references", () => {
  assert.deepEqual(GALAXY_OBJECT_KINDS, domainKinds)

  for (const kind of domainKinds) {
    const id = `${kind}:研究/🌀?sample=1`
    const latest = createGalaxyObjectReference(kind, id)
    const pinned = createGalaxyObjectReference(kind, id, { mode: "pinned", revision: "rev:7/sha256:abc" })

    assert.deepEqual(parseGalaxyObjectReference(latest), {
      schema: "gb.object-ref.v1",
      format: "canonical",
      kind,
      id,
      selector: { mode: "latest" },
    })
    assert.deepEqual(parseGalaxyObjectReference(pinned), {
      schema: "gb.object-ref.v1",
      format: "canonical",
      kind,
      id,
      selector: { mode: "pinned", revision: "rev:7/sha256:abc" },
    })
    assert.equal(serializeGalaxyObjectReference(parseGalaxyObjectReference(latest)), latest)
    assert.equal(serializeGalaxyObjectReference(parseGalaxyObjectReference(pinned)), pinned)
  }
})

test("legacy entity and node references preserve their existing wire form", () => {
  for (const kind of ["entity", "node"]) {
    const legacy = `gb:${kind}:${encodeURIComponent("claim:é/🌀")}`
    const parsed = parseGalaxyObjectReference(legacy)

    assert.deepEqual(parsed, {
      schema: "gb.object-ref.v1",
      format: "legacy",
      kind: `legacy.${kind}`,
      id: "claim:é/🌀",
      selector: { mode: "latest" },
    })
    assert.equal(serializeGalaxyObjectReference(parsed), legacy)
  }
})

test("code and proof references retain provider identities and immutable revisions", () => {
  const repositoryId = "code:v1:MonumentalSystems%2FGalaxyBrain"
  const codeRevision = `git:${"a".repeat(40)};snapshot:sha256:${"b".repeat(64)}`
  const codeRef = createGalaxyObjectReference("code.symbol", `${repositoryId}:Mathlib%2FProof.lean:theorem_name`, {
    mode: "pinned",
    revision: codeRevision,
  })
  const proofRef = createGalaxyObjectReference("proof.node", "proof-graph-1#root/theorem", {
    mode: "pinned",
    revision: `sha256:${"c".repeat(64)}`,
  })

  assert.equal(parseGalaxyObjectReference(codeRef).kind, "code.symbol")
  assert.equal(parseGalaxyObjectReference(codeRef).selector.revision, codeRevision)
  assert.equal(parseGalaxyObjectReference(proofRef).kind, "proof.node")
  assert.equal(parseGalaxyObjectReference(proofRef).id, "proof-graph-1#root/theorem")
})

test("documents and anchors retain durable Galaxy identities and content pins", () => {
  const revision = `sha256:${"d".repeat(64)}`
  const documentRef = createGalaxyObjectReference("document", "4fb6d8f3-b111-46ff-bf4a-70eca7aebfd7", {
    mode: "pinned",
    revision,
  })
  const anchorRef = createGalaxyObjectReference("document.anchor", `sha256:${"a".repeat(64)}`, {
    mode: "pinned",
    revision,
  })

  assert.deepEqual(parseGalaxyObjectReference(documentRef), {
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind: "document",
    id: "4fb6d8f3-b111-46ff-bf4a-70eca7aebfd7",
    selector: { mode: "pinned", revision },
  })
  assert.deepEqual(parseGalaxyObjectReference(anchorRef), {
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind: "document.anchor",
    id: `sha256:${"a".repeat(64)}`,
    selector: { mode: "pinned", revision },
  })
  assert.notEqual(
    planGalaxyObjectResolution(documentRef, scope).identityKey,
    planGalaxyObjectResolution(documentRef, { ...scope, tenantId: "tenant-b" }).identityKey,
  )
})

test("latest and pinned selectors create explicit authority-neutral resolution plans", () => {
  const latest = planGalaxyObjectResolution(createGalaxyObjectReference("paper", "paper-1"), scope)
  const pinned = planGalaxyObjectResolution(
    createGalaxyObjectReference("paper", "paper-1", { mode: "pinned", revision: "sha256:123" }),
    scope,
  )

  assert.deepEqual(
    { scope: latest.scope, followLatest: latest.followLatest, revision: latest.revision },
    { scope, followLatest: true, revision: null },
  )
  assert.deepEqual(
    { scope: pinned.scope, followLatest: pinned.followLatest, revision: pinned.revision },
    { scope, followLatest: false, revision: "sha256:123" },
  )
  assert.notEqual(latest.identityKey, pinned.identityKey)
  assert.match(latest.identityKey, /^gb\.resolve\.v1:tenant-a:principal%3Areader-a%7Cgrants%3Aeln%3Aread:paper:paper-1:latest$/)
  assert.match(pinned.identityKey, /:paper:paper-1:pinned:sha256%3A123$/)
})

test("resolution identity is partitioned by tenant, authority, and pinned revision", () => {
  const reference = createGalaxyObjectReference("artifact", "artifact-1", { mode: "pinned", revision: "rev-1" })
  const baseline = planGalaxyObjectResolution(reference, scope).identityKey
  const otherTenant = planGalaxyObjectResolution(reference, { ...scope, tenantId: "tenant-b" }).identityKey
  const otherAuthority = planGalaxyObjectResolution(reference, { ...scope, authorityScope: "principal:reader-b" }).identityKey
  const otherRevision = planGalaxyObjectResolution(
    createGalaxyObjectReference("artifact", "artifact-1", { mode: "pinned", revision: "rev-2" }),
    scope,
  ).identityKey

  assert.equal(new Set([baseline, otherTenant, otherAuthority, otherRevision]).size, 4)
})

test("resolution planning fails closed without a bounded tenant and authority scope", () => {
  const reference = createGalaxyObjectReference("paper", "paper-1")
  for (const invalidScope of [
    undefined,
    null,
    {},
    { tenantId: "tenant-a" },
    { authorityScope: "principal:a" },
    { tenantId: "", authorityScope: "principal:a" },
    { tenantId: "tenant-a", authorityScope: "" },
    { tenantId: "tenant\na", authorityScope: "principal:a" },
    { tenantId: "tenant-a", authorityScope: "a".repeat(513) },
  ]) {
    assert.equal(planGalaxyObjectResolution(reference, invalidScope), null)
  }
})

test("resolver selection is exact, side-effect free, and has no prototype fallback", () => {
  let calls = 0
  const resolver = () => { calls += 1 }
  const selected = selectGalaxyObjectResolver(createGalaxyObjectReference("claim", "claim-1"), scope, { claim: resolver })

  assert.equal(selected.resolver, resolver)
  assert.equal(selected.request.kind, "claim")
  assert.equal(calls, 0)
  assert.equal(selectGalaxyObjectResolver(createGalaxyObjectReference("paper", "paper-1"), scope, { claim: resolver }), null)
  assert.equal(
    selectGalaxyObjectResolver(createGalaxyObjectReference("paper", "paper-1"), scope, Object.create({ paper: resolver })),
    null,
  )
  assert.equal(selectGalaxyObjectResolver(createGalaxyObjectReference("paper", "paper-1"), null, { paper: resolver }), null)
})

test("parsing and serialization fail closed outside bounded canonical grammar", () => {
  const overlongId = "🌀".repeat(513)
  const overlongRevision = "r".repeat(257)

  assert.throws(() => createGalaxyObjectReference("unknown", "id"), /Unsupported/)
  assert.throws(() => createGalaxyObjectReference("legacy.entity", "id"), /Unsupported/)
  assert.throws(
    () => createGalaxyObjectReference("legacy.node", "id", { mode: "pinned", revision: "1" }),
    /Unsupported/,
  )
  assert.throws(() => createGalaxyObjectReference("paper", overlongId), /between 1 and 512/)
  assert.throws(
    () => createGalaxyObjectReference("paper", "id", { mode: "pinned", revision: overlongRevision }),
    /latest or pinned/,
  )
  assert.throws(() => createGalaxyObjectReference("paper", "line\nbreak"), /control characters/)
  assert.throws(
    () => createGalaxyObjectReference("paper", "id", { mode: "latest", revision: "contradiction" }),
    /latest or pinned/,
  )

  for (const invalid of [
    "gb:object:v2:paper:id:latest",
    "gb:object:v1:unknown:id:latest",
    "gb:object:v1:legacy.entity:id:latest",
    "gb:object:v1:legacy.node:id:pinned:1",
    "gb:object:v1:paper:%E0%A4%A:latest",
    "gb:object:v1:paper:id:latest:extra",
    "gb:object:v1:paper:id:pinned",
    "gb:object:v1:paper:id:pinned:",
    "gb:object:v1:paper:id:head",
    `gb:node:${encodeURIComponent("line\nbreak")}`,
    `gb:object:v1:paper:${encodeURIComponent("line\nbreak")}:latest`,
    "x".repeat(16_385),
  ]) {
    assert.equal(parseGalaxyObjectReference(invalid), null, invalid)
  }

  assert.equal(planGalaxyObjectResolution({ kind: "paper", id: "id", selector: { mode: "latest" } }, scope), null)
  assert.throws(
    () => serializeGalaxyObjectReference({
      format: "legacy",
      kind: "legacy.node",
      id: "id",
      selector: { mode: "latest" },
    }),
    /Invalid/,
  )
})

test("full Unicode boundaries are measured after decoding", () => {
  const id = "🌀".repeat(512)
  const revision = "版".repeat(256)
  const reference = createGalaxyObjectReference("artifact", id, { mode: "pinned", revision })

  assert.equal(parseGalaxyObjectReference(reference).id, id)
  assert.equal(parseGalaxyObjectReference(reference).selector.revision, revision)
})

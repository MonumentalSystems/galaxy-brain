import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { parseFormalProjectPackage } from "../lib/formal-project-package.js"
import {
  encodeFormalProjectPackageEnvelope,
  FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS,
} from "../lib/formal-project-package-envelope.js"

const COMMIT = "1".repeat(40)
const TREE = "2".repeat(40)
const MATHLIB = "3".repeat(40)
const CONVERSION_PROFILE = "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1"

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value))
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}

function conceptualDag(overrides = {}) {
  return {
    schemaVersion: "rosetta-authored-conceptual-dag/1.0.0",
    generatedAt: "2026-09-26T12:00:00Z",
    project: "leanproofs",
    revision: COMMIT,
    source: {
      path: "docs/mathlib-reuse-audit.md",
      sha256: "6".repeat(64),
      parserProfile: "mermaid-graph-td-v1",
    },
    counts: { nodes: 2, edges: 1 },
    nodes: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Definitions and base lemmas",
        category: "proven",
        rawLabel: "Foundation<br/>Definitions and base lemmas",
      },
      {
        id: "main",
        title: "Main theorem",
        description: "",
        category: "open",
        rawLabel: "Main theorem",
      },
    ],
    edges: [{
      id: "foundation-->main",
      source: "foundation",
      target: "main",
      semantics: "authored-prerequisite-to-dependent",
    }],
    claimBoundary: {
      authoredEdgesAreFormalDependencies: false,
      authoredMathematicalClaimsVerified: false,
      layer: "hypothesis-and-interpretation",
    },
    ...overrides,
  }
}

function repositoryFieldDag(overrides = {}) {
  return {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "leanproofs",
    graph_kind: "repository-field",
    title: "LeanProofs repository field",
    source_revision: {
      repository: "MonumentalSystems/LeanProofs",
      commit: COMMIT,
      tree: TREE,
      lean_toolchain: "leanprover/lean4:v4.30.0",
      mathlib_revision: MATHLIB,
    },
    targets: [
      {
        target_id: "foundation",
        target_kind: "definition",
        title: "Foundation",
        category: "proven",
        formal_binding: { status: "mapped" },
      },
      {
        target_id: "main",
        target_kind: "theorem",
        title: "Main theorem",
        category: "open",
        formal_binding: { status: "mapped" },
      },
    ],
    relations: [{
      relation_id: "foundation-->main",
      relation_type: "AUTHORED_PREREQUISITE",
      prerequisite_target_id: "foundation",
      dependent_target_id: "main",
    }],
    ...overrides,
  }
}

function correspondence(overrides = {}) {
  return {
    schemaVersion: "rosetta-authored-formal-correspondence/1.0.0",
    generatedAt: "2026-09-26T12:00:00Z",
    project: "leanproofs",
    revision: COMMIT,
    visibility: "private",
    mappingProfile: {
      rule: "exact-authored-title-to-module-suffix-v1",
      cohortSemantics: "all exported declarations in the uniquely matched module",
      humanMappingsClaimed: false,
    },
    counts: {
      formalDeclarations: 2,
      formalDependenciesWithinProject: 1,
      declarationKinds: { theorem: 1, definition: 1 },
      dependencyKinds: { declaration: 1 },
      dependenciesTargetingInstances: 0,
      authoredNodeMappings: { mapped: 2 },
      authoredEdgeClassifications: { "supported-direct": 1 },
    },
    nodeMappings: {
      foundation: {
        status: "mapped",
        rule: "exact-authored-title-to-module-suffix-v1",
        moduleCandidates: ["LeanProofs.Foundation"],
        formalDeclarations: ["LeanProofs.Foundation.definition"],
      },
      main: {
        status: "mapped",
        rule: "exact-authored-title-to-module-suffix-v1",
        moduleCandidates: ["LeanProofs.Main"],
        formalDeclarations: ["LeanProofs.Main.theorem"],
      },
    },
    edgeCorrespondence: [{
      authoredEdge: "foundation-->main",
      prerequisite: "foundation",
      dependent: "main",
      status: "supported-direct",
      supportKind: "direct",
      formalPath: ["LeanProofs.Main.theorem", "LeanProofs.Foundation.definition"],
      formalEdgeKinds: [["declaration"]],
    }],
    bridgeNominations: [],
    claimBoundary: {
      moduleCohortMappingIsDeclarationEquivalence: false,
      unsupportedEdgeIsMathematicallyFalse: false,
      formalDependencyImpliesAuthoredInterpretation: false,
      shortestPathsRestrictedToExportedLeanProofsDeclarations: true,
      projectLocalAxiomPathStatusIsAxiomClosure: false,
      externalLeanOrMathlibAxiomsClassified: false,
      parallelDependencyPathsClassified: false,
      proofTermsOrSourceTextSerialized: false,
    },
    ...overrides,
  }
}

function packageInput(options = {}) {
  const conceptualBytes = options.authoredConceptualDagBytes
    || bytes(options.authoredConceptualDag || conceptualDag())
  const fieldBytes = options.repositoryFieldDagBytes
    || bytes(options.repositoryFieldDag || repositoryFieldDag())
  const correspondenceBytes = options.correspondenceBytes
    || bytes(options.correspondence || correspondence())
  const manifest = {
    schemaId: "rosetta.formal-project-package.v1",
    projectId: "leanproofs",
    repository: "MonumentalSystems/LeanProofs",
    commit: COMMIT,
    tree: TREE,
    environment: {
      leanToolchain: "leanprover/lean4:v4.30.0",
      mathlibRevision: MATHLIB,
    },
    conversionProfile: CONVERSION_PROFILE,
    artifacts: {
      formalGraph: { format: "jsonl", sha256: "4".repeat(64) },
      repositoryGraph: { format: "json", sha256: "5".repeat(64) },
      authoredConceptualDag: { format: "json", sha256: hash(conceptualBytes) },
      repositoryFieldDag: { format: "json", sha256: hash(fieldBytes) },
      correspondence: { format: "json", sha256: hash(correspondenceBytes) },
    },
    ...options.manifest,
  }
  return {
    manifestBytes: bytes(manifest),
    authoredConceptualDagBytes: conceptualBytes,
    repositoryFieldDagBytes: fieldBytes,
    correspondenceBytes,
  }
}

test("preserves the raw producer DAG separately from the frozen Galaxy projection", async () => {
  const input = packageInput()
  const result = await parseFormalProjectPackage(input)

  assert.equal(result.conversionProfile, CONVERSION_PROFILE)
  assert.equal(result.authoredConceptualDag.schemaVersion, "rosetta-authored-conceptual-dag/1.0.0")
  assert.equal(result.repositoryFieldDag.graph_kind, "repository-field")
  assert.equal(result.authoredConceptualDagSha256, hash(input.authoredConceptualDagBytes))
  assert.equal(result.repositoryFieldDagSha256, hash(input.repositoryFieldDagBytes))
  assert.notEqual(result.authoredConceptualDagSha256, result.repositoryFieldDagSha256)
  assert.deepEqual(result.artifacts.formalGraph, { format: "jsonl", sha256: "4".repeat(64) })
  assert.deepEqual(result.artifacts.repositoryGraph, { format: "json", sha256: "5".repeat(64) })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.authoredConceptualDag.nodes[0]), true)
  assert.equal(Object.isFrozen(result.repositoryFieldDag.source_revision), true)
})

test("rejects tampering in either raw or projected bytes", async (t) => {
  await t.test("raw conceptual DAG", async () => {
    const input = packageInput()
    const changed = conceptualDag()
    changed.nodes[0].title = "Changed"
    input.authoredConceptualDagBytes = bytes(changed)
    await assert.rejects(
      () => parseFormalProjectPackage(input),
      /Authored conceptual DAG SHA-256 does not match/u,
    )
  })

  await t.test("repository-field projection", async () => {
    const input = packageInput()
    input.repositoryFieldDagBytes = bytes(repositoryFieldDag({ title: "Changed" }))
    await assert.rejects(
      () => parseFormalProjectPackage(input),
      /Repository-field DAG SHA-256 does not match/u,
    )
  })
})

test("rejects active projections, unknown conversion profiles, and tree drift", async (t) => {
  await t.test("active graph", async () => {
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({
        repositoryFieldDag: repositoryFieldDag({ graph_kind: "mission" }),
      })),
      /must be passive/u,
    )
  })

  await t.test("conversion profile", async () => {
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ manifest: { conversionProfile: "latest" } })),
      /conversionProfile/u,
    )
  })

  await t.test("tree", async () => {
    const field = repositoryFieldDag()
    field.source_revision.tree = "7".repeat(40)
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ repositoryFieldDag: field })),
      /source_revision\.tree must match/u,
    )
  })
})

test("rejects lifecycle and status smuggling while retaining formal classifications", async () => {
  await assert.rejects(
    () => parseFormalProjectPackage(packageInput({
      repositoryFieldDag: repositoryFieldDag({ status: "verified" }),
    })),
    /live status state/u,
  )

  const provider = repositoryFieldDag()
  provider.targets[0].prove2meStatus = "accepted"
  await assert.rejects(
    () => parseFormalProjectPackage(packageInput({ repositoryFieldDag: provider })),
    /provider or proof lifecycle state/u,
  )

  const lifecycleKeys = [
    "work", "works", "workstate", "workstates", "workstatus", "workstatuses",
    "claim", "claims", "claimid", "claimids", "claimstate", "claimstates",
    "claimstatus", "claimstatuses", "run", "runs", "runid", "runids", "runstate",
    "runstates", "runstatus", "runstatuses", "frontier", "frontiers",
    "frontierstate", "frontierstates", "frontierstatus", "frontierstatuses",
    "mission", "missions", "missionid", "missionids", "missionstate", "missionstates",
    "missionstatus", "missionstatuses", "campaign", "campaigns", "workspace",
    "workspaces", "workspaceid", "workspaceids", "workspacekey", "workspacekeys",
    "verification", "verifications", "verificationstatus", "verificationstatuses",
    "proofstatus", "proofstatuses", "provider", "providers", "providerstatus",
    "providerstatuses", "external", "prove2me", "prove2mestatus",
    "prove2meaccepted", "rosetta", "rosettastatus", "rosettapublished",
    "hyades", "hyadesrun", "hyadesstatus", "live", "livestate", "livestatus",
  ]
  for (const key of lifecycleKeys) {
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({
        repositoryFieldDag: repositoryFieldDag({ [key]: [] }),
      })),
      new RegExp(`${key} is provider or proof lifecycle state`, "u"),
    )
  }

  const drift = repositoryFieldDag()
  drift.targets[0].formal_binding.status = "unmapped"
  await assert.rejects(
    () => parseFormalProjectPackage(packageInput({ repositoryFieldDag: drift })),
    /formal_binding\.status does not match correspondence classification/u,
  )

  const verifiedField = repositoryFieldDag()
  verifiedField.targets[0].formal_binding.status = "verified"
  const verifiedCorrespondence = correspondence()
  verifiedCorrespondence.nodeMappings.foundation.status = "verified"
  await assert.rejects(
    () => parseFormalProjectPackage(packageInput({
      repositoryFieldDag: verifiedField,
      correspondence: verifiedCorrespondence,
    })),
    /is not a formal mapping classification/u,
  )

  const accepted = await parseFormalProjectPackage(packageInput())
  assert.equal(accepted.authoredConceptualDag.nodes[0].category, "proven")
  assert.equal(accepted.correspondence.edgeCorrespondence[0].status, "supported-direct")
})

test("cross-binds raw nodes and edges one-to-one to projection and correspondence", async (t) => {
  await t.test("projection node", async () => {
    const field = repositoryFieldDag()
    field.targets[0].target_id = "different"
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ repositoryFieldDag: field })),
      /targets must exactly match/u,
    )
  })

  await t.test("projection edge endpoint", async () => {
    const field = repositoryFieldDag()
    field.relations[0].prerequisite_target_id = "main"
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ repositoryFieldDag: field })),
      /does not match the authored conceptual edge/u,
    )
  })

  await t.test("correspondence node", async () => {
    const value = correspondence()
    delete value.nodeMappings.foundation
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ correspondence: value })),
      /nodeMappings must exactly match/u,
    )
  })

  await t.test("correspondence edge endpoint", async () => {
    const value = correspondence()
    value.edgeCorrespondence[0].dependent = "foundation"
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ correspondence: value })),
      /endpoints do not match/u,
    )
  })
})

function identifierInput(length) {
  const id = "n".repeat(length)
  const raw = conceptualDag({
    counts: { nodes: 1, edges: 0 },
    nodes: [{ id, title: "Node", description: "", category: "open", rawLabel: "Node" }],
    edges: [],
  })
  const field = repositoryFieldDag({
    targets: [{ target_id: id, title: "Node", category: "open" }],
    relations: [],
  })
  const mapping = correspondence({
    counts: {
      formalDeclarations: 0,
      formalDependenciesWithinProject: 0,
      declarationKinds: {},
      dependencyKinds: {},
      dependenciesTargetingInstances: 0,
      authoredNodeMappings: { unmapped: 1 },
      authoredEdgeClassifications: {},
    },
    nodeMappings: {
      [id]: {
        status: "unmapped",
        rule: "exact-authored-title-to-module-suffix-v1",
        moduleCandidates: [],
        formalDeclarations: [],
      },
    },
    edgeCorrespondence: [],
  })
  return packageInput({ authoredConceptualDag: raw, repositoryFieldDag: field, correspondence: mapping })
}

function projectIdentifierInput(length) {
  const projectId = "p".repeat(length)
  return packageInput({
    manifest: { projectId },
    authoredConceptualDag: conceptualDag({ project: projectId }),
    repositoryFieldDag: repositoryFieldDag({ graph_id: projectId }),
    correspondence: correspondence({ project: projectId }),
  })
}

test("uses the shared 512-character graph-node identifier boundary", async () => {
  for (const length of [120, 121, 512]) {
    await assert.doesNotReject(() => parseFormalProjectPackage(identifierInput(length)))
    await assert.doesNotReject(() => parseFormalProjectPackage(projectIdentifierInput(length)))
  }
  await assert.rejects(() => parseFormalProjectPackage(identifierInput(513)), /\.id is invalid/u)
  await assert.rejects(
    () => parseFormalProjectPackage(projectIdentifierInput(513)),
    /projectId is invalid/u,
  )
})

test("snapshots all caller-owned bytes and returns deterministic output", async () => {
  const input = packageInput()
  const expected = await parseFormalProjectPackage(packageInput())
  const pending = parseFormalProjectPackage(input)
  input.manifestBytes.fill(0)
  input.authoredConceptualDagBytes.fill(0)
  input.repositoryFieldDagBytes.fill(0)
  input.correspondenceBytes.fill(0)
  const actual = await pending

  assert.deepEqual(actual, expected)
  assert.equal(JSON.stringify(actual), JSON.stringify(expected))
})

test("rejects duplicate keys, non-finite numbers, and unknown producer fields", async (t) => {
  await t.test("duplicate manifest key", async () => {
    const input = packageInput()
    const source = new TextDecoder().decode(input.manifestBytes)
    input.manifestBytes = new TextEncoder().encode(source.replace(
      '"schemaId":"rosetta.formal-project-package.v1"',
      '"schemaId":"rosetta.formal-project-package.v1","schemaId":"rosetta.formal-project-package.v1"',
    ))
    await assert.rejects(() => parseFormalProjectPackage(input), /duplicate JSON key schemaId/u)
  })

  await t.test("non-finite correspondence number", async () => {
    const input = packageInput()
    const source = new TextDecoder().decode(input.correspondenceBytes)
    input.correspondenceBytes = new TextEncoder().encode(source.replace(
      '"formalDeclarations":2',
      '"formalDeclarations":1e9999',
    ))
    const manifest = JSON.parse(new TextDecoder().decode(input.manifestBytes))
    manifest.artifacts.correspondence.sha256 = hash(input.correspondenceBytes)
    input.manifestBytes = bytes(manifest)
    await assert.rejects(() => parseFormalProjectPackage(input), /non-finite JSON number/u)
  })

  await t.test("unknown raw producer field", async () => {
    const raw = conceptualDag({ published: true })
    await assert.rejects(
      () => parseFormalProjectPackage(packageInput({ authoredConceptualDag: raw })),
      /unsupported field published/u,
    )
  })
})

test("encodes the exact four package artifacts in one bounded signed envelope", () => {
  const input = packageInput()
  const envelope = encodeFormalProjectPackageEnvelope(input)
  assert.equal(envelope.byteLength,
    24 + input.manifestBytes.byteLength + input.authoredConceptualDagBytes.byteLength
    + input.repositoryFieldDagBytes.byteLength + input.correspondenceBytes.byteLength)
  assert.deepEqual([...envelope.subarray(0, 8)], [0x47, 0x42, 0x46, 0x50, 0x50, 0x31, 0, 0])
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
  assert.deepEqual([8, 12, 16, 20].map((offset) => view.getUint32(offset, false)), [
    input.manifestBytes.byteLength,
    input.authoredConceptualDagBytes.byteLength,
    input.repositoryFieldDagBytes.byteLength,
    input.correspondenceBytes.byteLength,
  ])
  const payload = envelope.subarray(24)
  const expected = Buffer.concat(Object.values(input).map((value) => Buffer.from(value)))
  assert.deepEqual(Buffer.from(payload), expected)
  assert.equal(FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.totalBytes, 50_397_208)
  assert.throws(() => encodeFormalProjectPackageEnvelope({
    ...input,
    manifestBytes: new Uint8Array(),
  }), /manifestBytes must be bounded exact bytes/u)
})

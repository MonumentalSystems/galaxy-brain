# Formal project package boundary

`rosetta.formal-project-package.v1` binds one exact Lean repository revision to
the source, projection, and formal artifacts needed for durable
interoperability:

```json
{
  "schemaId": "rosetta.formal-project-package.v1",
  "projectId": "leanproofs",
  "repository": "MonumentalSystems/LeanProofs",
  "commit": "<git-commit>",
  "tree": "<git-tree>",
  "environment": {
    "leanToolchain": "leanprover/lean4:v4.30.0",
    "mathlibRevision": "<git-commit>"
  },
  "conversionProfile": "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1",
  "artifacts": {
    "formalGraph": { "format": "jsonl", "sha256": "<sha256>" },
    "repositoryGraph": { "format": "json", "sha256": "<sha256>" },
    "authoredConceptualDag": { "format": "json", "sha256": "<sha256>" },
    "repositoryFieldDag": { "format": "json", "sha256": "<sha256>" },
    "correspondence": { "format": "json", "sha256": "<sha256>" }
  }
}
```

The manifest is provenance, not proof status. In particular:

- `authoredConceptualDag` is the exact
  `rosetta-authored-conceptual-dag/1.0.0` producer artifact. It is never
  silently reinterpreted as a Galaxy graph.
- `repositoryFieldDag` is a separately hashed, deterministic
  `galaxy.proof-dag.v1` `repository-field` projection made by the declared
  conversion profile. Its target and relation identities and endpoints must
  map one-to-one to the authored source. Importing it never creates a mission,
  frontier, claim, run, or work-state workspace.
- `correspondence` records bounded Rosetta authored-to-formal mappings and edge
  classifications. A mapping is not a Lean verification receipt and an
  unsupported authored edge is not a mathematical refutation.
- Prove2Me acceptance, Hyades verification, and Rosetta publication remain
  separate provider/status lanes. None may be inferred from package presence.
- The projection's source revision must exactly match the package repository,
  commit, tree, Lean toolchain, and Mathlib revision.

## Materialization boundary

The canonical formal graph may be many gigabytes. A browser review must not
load it merely to register a compact authored DAG. The first package adapter
therefore materializes and verifies the bounded `authoredConceptualDag`,
`repositoryFieldDag`, and `correspondence` artifacts while retaining the exact
hash descriptors for the external formal and repository graphs. A later
server import route may stream or register those large artifacts through a
bounded object-store path without changing this manifest.

The pure validation/projection adapter remains free of database and provider
effects. Its authenticated persistence boundary is a separate operation:

- `POST /formal-project-packages` accepts one freshly signed
  `application/vnd.galaxy.formal-project-package` binary envelope. The envelope
  has the eight-byte magic `GBFPP1\0\0`, four big-endian unsigned 32-bit byte
  lengths, then the exact manifest, authored DAG, repository-field DAG, and
  correspondence bytes in that order.
- The measured request maximum is 50,397,208 bytes. Both the browser proxy and
  Python API enforce it independently; `Content-Length` is not trusted.
- Validation occurs before persistence. One database transaction stores the
  exact manifest, authored DAG, and correspondence artifacts, invokes the
  passive proof-graph registry for the exact repository-field bytes, and then
  records their immutable package binding.
- Exact manifest-hash replay is idempotent and retains original attribution.
  The package table, artifacts, and proof graph are append-only and tenant
  isolated.
- `GET /formal-project-packages/{manifest_sha256}` returns bounded metadata and
  distinguishes materialized compact artifacts from descriptor-only formal and
  repository graphs.

Import still performs no provider call, mission activation, workspace or
frontier creation, proof verification, or publication. A package registration
is structural provenance, never a claim that its theorems have been accepted,
verified, or published.

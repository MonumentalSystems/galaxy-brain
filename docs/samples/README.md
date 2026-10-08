# Sample artifacts

## `codebase-memory.snapshot.json`

A small, inert code-graph export shaped for
`createCodebaseMemoryJsonProvider`. It pins a Git commit and content-addressed
graph snapshot, then models two Lean files, a theorem, a lemma, and their
deterministic structural relationships. See `docs/CODE_GRAPH_PROVIDER.md` for
the provider boundary, canonical code object IDs, revision grammar, limits,
and deployment isolation requirements.

## `proof-dag.example.json`

A minimal but valid `galaxy.proof-dag.v1` document. Paste it into the proof
campaign manifest box on `/tasks` to render the zoomable proof graph, which
stays hidden until a manifest parses.

The schema is easy to get wrong, because the field names do not match the more
familiar "nodes and edges" vocabulary:

| Concept | Field |
| --- | --- |
| Node list | `targets` (1–10,000), each with a unique `target_id` |
| Edge list | `relations` (≤50,000), each with a unique `relation_id` |
| Edge direction | `prerequisite_target_id` → `dependent_target_id` |
| Edge kind | `relation_type` |

`relation_type` must be one of `MILESTONE_OF`, `DEPENDS_ON`, `REDUCES_TO`,
`USES`, `PROMOTED_TO`, or `AUTHORED_PREREQUISITE`. Of those, `DEPENDS_ON`,
`REDUCES_TO`, `USES`, and `AUTHORED_PREREQUISITE` are prerequisite edges and so
determine each node's layer. Self-referential relations and duplicate ids are
rejected, and every relation must reference targets that exist.

`graph_kind` records structure; generic uploads accept only passive
`repository-field` graphs. Claimable missions are derived server-side from one
exact registered source and cannot be created by relabeling an upload.

This example parses to five nodes across four layers, branching at `setup` and
joining again at `transition`.

## `proof-verification-set.empty.json`

The canonical zero-inheritance `galaxy.proof-verification-set.v1` shape. Replace
the graph ID and digest with an exact registered passive graph before posting
it to `/api/eln/proof-verification-sets`. The empty `items` array explicitly
states that no source nodes are inherited as verified. Registration stores an
immutable baseline artifact but creates no mission, workspace, task, claim, or
frontier.

Non-empty sets additionally embed exact opaque receipt bytes and identify a
versioned verifier adapter. They fail closed unless that server adapter is
enabled and authenticates or replays each receipt. Today only `proofs-blah-dev`
version `1`, for signed proofs.blah.dev reports, is enabled. Receipt-shaped JSON
and repository categories are not verification.

## `proof-dag.prove2me.json`

A synthetic sample with the exact shape of a real decomposition converted from
Prove2me's `GET /api/v1/theorems/:id/graph`: 41 targets and 34 relations over
four layers. Titles, summaries, and identifiers are placeholders, so no
third-party theorem text is reproduced. Larger than the hand-written example,
and useful for seeing how the graph reads at each zoom tier.

Prove2me models a decomposition as a bipartite graph. Its `nodes` carry a
`node_type` of `theorem` or `sketch`, and sketch nodes are keyed by `node_id`
rather than `theorem_id`. Its `edges` come in two kinds:

- `sketch` — child theorem to sketch, and sketch to parent theorem
- `structural` — theorem to theorem, already transitively resolved

Only the `structural` edges are needed here: their `source` is the prerequisite
and their `target` is the dependent, which is the direction
`galaxy.proof-dag.v1` relations already use. `REDUCES_TO` is the closest
relation type, since a Prove2me sketch proves its parent by importing children.
The adapter always imports this provider structure as a passive
`repository-field`. Each target retains only its stable Prove2Me theorem ID
under `external.prove2me`. Mutable Prove2Me status belongs in the separate proof
work-state overlay; it is absent from the immutable DAG and never becomes a
category, formal binding, Galaxy verification, or authority to activate work.

from __future__ import annotations

import hashlib
import json
import unittest
from unittest.mock import patch

import formal_project_package as package
from formal_project_package import (
    FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER,
    FORMAL_PROJECT_PACKAGE_ENVELOPE_MAGIC,
    FormalProjectPackageError,
    parse_formal_project_package,
    parse_formal_project_package_envelope,
)


COMMIT = "1" * 40
TREE = "2" * 40
MATHLIB = "3" * 40
REPOSITORY = "DavinciDreams/LeanProofs"


def exact_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def conceptual_dag(*, project="leanproofs", commit=COMMIT, node_ids=("root", "root2"), extra=None):
    value = {
        "schemaVersion": "rosetta-authored-conceptual-dag/1.0.0",
        "generatedAt": "2026-09-26T00:00:00Z",
        "project": project,
        "revision": commit,
        "source": {"path": "docs/authored.mmd", "sha256": "a" * 64, "parserProfile": "rosetta-mermaid-flowchart-v1"},
        "counts": {"nodes": len(node_ids), "edges": 1},
        "nodes": [{
            "id": node_id, "title": f"Node {index}",
            "description": "" if index == 0 else "A derived conceptual target.",
            "category": "concept", "rawLabel": f"Node {index}",
        } for index, node_id in enumerate(node_ids)],
        "edges": [{
            "id": f"{node_ids[0]}-->{node_ids[1]}", "source": node_ids[0],
            "target": node_ids[1], "semantics": "authored-prerequisite-to-dependent",
        }],
        "claimBoundary": {
            "authoredEdgesAreFormalDependencies": False,
            "authoredMathematicalClaimsVerified": False,
            "layer": "hypothesis-and-interpretation",
        },
    }
    if extra:
        value.update(extra)
    return exact_json(value)


def repository_field_dag(*, commit=COMMIT, tree=TREE, kind="repository-field", node_ids=("root", "root2"), edge_id=None, extra=None):
    edge_id = edge_id or f"{node_ids[0]}-->{node_ids[1]}"
    value = {
        "schema_id": "galaxy.proof-dag.v1", "graph_id": "leanproofs",
        "graph_kind": kind, "title": "LeanProofs authored repository field",
        "source_revision": {
            "repository": REPOSITORY, "commit": commit, "tree": tree,
            "lean_toolchain": "v4.19.0", "mathlib_revision": MATHLIB,
        },
        "targets": [{
            "target_id": node_id, "title": f"Node {index}",
            "formal_binding": {"status": "mapped"},
        } for index, node_id in enumerate(node_ids)],
        "relations": [{
            "relation_id": edge_id, "relation_type": "AUTHORED_PREREQUISITE",
            "prerequisite_target_id": node_ids[0], "dependent_target_id": node_ids[1],
        }],
    }
    if extra:
        value.update(extra)
    return exact_json(value)


def correspondence(*, project="leanproofs", revision=COMMIT, node_ids=("root", "root2"), extra=None):
    edge_id = f"{node_ids[0]}-->{node_ids[1]}"
    value = {
        "schemaVersion": "rosetta-authored-formal-correspondence/1.0.0",
        "generatedAt": "2026-09-26T00:00:00Z", "project": project,
        "revision": revision, "visibility": "private",
        "mappingProfile": {
            "rule": "exact-authored-title-to-module-suffix-v1",
            "cohortSemantics": "all exported declarations in the uniquely matched module",
            "humanMappingsClaimed": False,
        },
        "counts": {
            "formalDeclarations": 2, "formalDependenciesWithinProject": 1,
            "declarationKinds": {"theorem": 2}, "dependencyKinds": {"proof": 1},
            "dependenciesTargetingInstances": 0, "authoredNodeMappings": {"mapped": 2},
            "authoredEdgeClassifications": {"supported-direct": 1},
        },
        "nodeMappings": {node_id: {
            "status": "mapped", "rule": "exact-authored-title-to-module-suffix-v1",
            "moduleCandidates": [f"LeanProofs.Node{index}"],
            "formalDeclarations": [f"LeanProofs.Node{index}.theorem"],
        } for index, node_id in enumerate(node_ids)},
        "edgeCorrespondence": [{
            "authoredEdge": edge_id, "prerequisite": node_ids[0], "dependent": node_ids[1],
            "status": "supported-direct", "supportKind": "direct",
            "formalPath": ["LeanProofs.Node1.theorem", "LeanProofs.Node0.theorem"],
            "formalEdgeKinds": [["proof"]],
        }],
        "bridgeNominations": [],
        "claimBoundary": {
            "moduleCohortMappingIsDeclarationEquivalence": False,
            "unsupportedEdgeIsMathematicallyFalse": False,
            "formalDependencyImpliesAuthoredInterpretation": False,
            "shortestPathsRestrictedToExportedLeanProofsDeclarations": True,
            "projectLocalAxiomPathStatusIsAxiomClosure": False,
            "externalLeanOrMathlibAxiomsClassified": False,
            "parallelDependencyPathsClassified": False,
            "proofTermsOrSourceTextSerialized": False,
        },
    }
    if extra:
        value.update(extra)
    return exact_json(value)


def manifest(raw: bytes, projected: bytes, mapping: bytes, *, project="leanproofs", overrides=None):
    value = {
        "schemaId": "rosetta.formal-project-package.v1", "projectId": project,
        "repository": REPOSITORY, "commit": COMMIT, "tree": TREE,
        "environment": {"leanToolchain": "v4.19.0", "mathlibRevision": MATHLIB},
        "conversionProfile": package.CONVERSION_PROFILE,
        "artifacts": {
            "formalGraph": {"format": "jsonl", "sha256": "4" * 64},
            "repositoryGraph": {"format": "json", "sha256": "5" * 64},
            "authoredConceptualDag": {"format": "json", "sha256": hashlib.sha256(raw).hexdigest()},
            "repositoryFieldDag": {"format": "json", "sha256": hashlib.sha256(projected).hexdigest()},
            "correspondence": {"format": "json", "sha256": hashlib.sha256(mapping).hexdigest()},
        },
    }
    if overrides:
        value.update(overrides)
    return exact_json(value)


def package_envelope(source, raw, projected, mapping):
    return FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.pack(
        FORMAL_PROJECT_PACKAGE_ENVELOPE_MAGIC,
        len(source), len(raw), len(projected), len(mapping),
    ) + source + raw + projected + mapping


def parse_fixture(*, project="leanproofs", node_ids=("root", "root2")):
    raw = conceptual_dag(project=project, node_ids=node_ids)
    projected = repository_field_dag(node_ids=node_ids)
    mapping = correspondence(project=project, node_ids=node_ids)
    return parse_formal_project_package(manifest(raw, projected, mapping, project=project), raw, projected, mapping)


class FormalProjectPackageTests(unittest.TestCase):
    def test_realistic_producer_fixture_preserves_distinct_exact_artifacts(self):
        raw, projected, mapping = conceptual_dag(), repository_field_dag(), correspondence()
        source = manifest(raw, projected, mapping)
        result = parse_formal_project_package(source, raw, projected, mapping)
        self.assertEqual(result.manifest_bytes, source)
        self.assertEqual(result.authored_conceptual_dag_bytes, raw)
        self.assertEqual(result.repository_field_dag_bytes, projected)
        self.assertEqual(result.correspondence_bytes, mapping)
        self.assertEqual(result.authored_conceptual_dag_sha256, hashlib.sha256(raw).hexdigest())
        self.assertEqual(result.repository_field_dag_sha256, hashlib.sha256(projected).hexdigest())
        self.assertEqual(result.proof_dag.graph_kind, "repository-field")
        self.assertEqual(result.conversion_profile, package.CONVERSION_PROFILE)
        self.assertEqual(result.formal_graph.sha256, "4" * 64)

    def test_hash_swaps_and_byte_tampering_fail_closed(self):
        raw, projected, mapping = conceptual_dag(), repository_field_dag(), correspondence()
        value = json.loads(manifest(raw, projected, mapping))
        value["artifacts"]["authoredConceptualDag"]["sha256"] = value["artifacts"]["repositoryFieldDag"]["sha256"]
        with self.assertRaisesRegex(FormalProjectPackageError, "Authored conceptual DAG SHA-256"):
            parse_formal_project_package(exact_json(value), raw, projected, mapping)
        tampered = projected.replace(b'"title":"Node 0"', b'"title":"Tampered"')
        with self.assertRaisesRegex(FormalProjectPackageError, "Repository-field DAG SHA-256"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, tampered, mapping)

    def test_revision_tree_and_conversion_profile_are_exactly_bound(self):
        raw, mapping = conceptual_dag(), correspondence()
        projected = repository_field_dag(tree="9" * 40)
        with self.assertRaisesRegex(FormalProjectPackageError, "source_revision.tree"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        projected = repository_field_dag()
        with self.assertRaisesRegex(FormalProjectPackageError, "conversionProfile"):
            parse_formal_project_package(manifest(raw, projected, mapping, overrides={"conversionProfile": "unversioned"}), raw, projected, mapping)

    def test_active_live_state_and_generic_status_are_rejected(self):
        raw, mapping = conceptual_dag(), correspondence()
        active = repository_field_dag(kind="mission")
        with self.assertRaisesRegex(FormalProjectPackageError, "must be passive"):
            parse_formal_project_package(manifest(raw, active, mapping), raw, active, mapping)
        for extra in ({"mission": {"status": "running"}}, {"status": "running"}):
            projected = repository_field_dag(extra=extra)
            with self.subTest(extra=extra), self.assertRaisesRegex(FormalProjectPackageError, "lifecycle state|live status state"):
                parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        self.assertEqual(parse_fixture().proof_dag.artifact["targets"][0]["formal_binding"]["status"], "mapped")

    def test_formal_binding_status_is_only_the_correspondence_classification(self):
        raw = conceptual_dag()
        projected_value = json.loads(repository_field_dag())
        projected_value["targets"][0]["formal_binding"]["status"] = "unmapped"
        projected = exact_json(projected_value)
        mapping = correspondence()
        with self.assertRaisesRegex(FormalProjectPackageError, "does not match correspondence"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

        projected_value["targets"][0]["formal_binding"]["status"] = "verified"
        projected = exact_json(projected_value)
        mapping_value = json.loads(mapping)
        mapping_value["nodeMappings"]["root"]["status"] = "verified"
        mapping = exact_json(mapping_value)
        with self.assertRaisesRegex(FormalProjectPackageError, "not an authored mapping classification"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

        projected_value["targets"][0]["formal_binding"]["status"] = "ambiguous"
        projected = exact_json(projected_value)
        mapping_value["nodeMappings"]["root"]["status"] = "ambiguous"
        mapping = exact_json(mapping_value)
        result = parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        self.assertEqual(result.proof_dag.artifact["targets"][0]["formal_binding"]["status"], "ambiguous")

        projected_value["targets"][0]["formal_binding"]["status"] = "module-without-exported-declarations"
        projected = exact_json(projected_value)
        mapping_value["nodeMappings"]["root"]["status"] = "module-without-exported-declarations"
        mapping = exact_json(mapping_value)
        result = parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        self.assertEqual(
            result.proof_dag.artifact["targets"][0]["formal_binding"]["status"],
            "module-without-exported-declarations",
        )

    def test_plural_lifecycle_containers_remain_rejected(self):
        raw, mapping = conceptual_dag(), correspondence()
        lifecycle_fields = (
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
        )
        for field in lifecycle_fields:
            projected = repository_field_dag(extra={field: []})
            with self.subTest(field=field), self.assertRaisesRegex(FormalProjectPackageError, "lifecycle state"):
                parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

    def test_raw_projection_and_correspondence_are_one_to_one(self):
        raw, mapping = conceptual_dag(), correspondence()
        projected = repository_field_dag(edge_id="different-edge")
        with self.assertRaisesRegex(FormalProjectPackageError, "relations do not match"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        projected = repository_field_dag()
        value = json.loads(mapping)
        value["edgeCorrespondence"][0]["dependent"] = "root"
        mapping = exact_json(value)
        with self.assertRaisesRegex(FormalProjectPackageError, "endpoints do not match"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        value = json.loads(correspondence())
        value["nodeMappings"].pop("root2")
        mapping = exact_json(value)
        with self.assertRaisesRegex(FormalProjectPackageError, "nodeMappings"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

    def test_raw_producer_shape_counts_and_claim_boundary_are_exact(self):
        projected, mapping = repository_field_dag(), correspondence()
        value = json.loads(conceptual_dag())
        value["counts"]["nodes"] = 3
        raw = exact_json(value)
        with self.assertRaisesRegex(FormalProjectPackageError, "counts must match"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
        value = json.loads(conceptual_dag())
        value["claimBoundary"]["authoredEdgesAreFormalDependencies"] = True
        raw = exact_json(value)
        with self.assertRaisesRegex(FormalProjectPackageError, "cannot claim"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

    def test_identifier_lengths_120_121_512_and_513(self):
        for length in (120, 121, 512):
            with self.subTest(length=length):
                self.assertEqual(parse_fixture(project="p" * length).project_id, "p" * length)
        project = "p" * 513
        raw, projected, mapping = conceptual_dag(project=project), repository_field_dag(), correspondence(project=project)
        with self.assertRaisesRegex(FormalProjectPackageError, "projectId exceeds 512"):
            parse_formal_project_package(manifest(raw, projected, mapping, project=project), raw, projected, mapping)

        # A single-node producer artifact exercises the full 512-character node-ID bound
        # without making its producer-derived "source-->target" edge ID exceed 512.
        for length, succeeds in ((512, True), (513, False)):
            node_id = "n" * length
            raw_value = json.loads(conceptual_dag())
            raw_value["nodes"] = [{
                "id": node_id, "title": "Only", "description": "",
                "category": "concept", "rawLabel": "Only",
            }]
            raw_value["edges"] = []
            raw_value["counts"] = {"nodes": 1, "edges": 0}
            raw = exact_json(raw_value)
            projected_value = json.loads(repository_field_dag())
            projected_value["targets"] = [{"target_id": node_id, "title": "Only"}]
            projected_value["relations"] = []
            projected = exact_json(projected_value)
            mapping_value = json.loads(correspondence())
            mapping_value["nodeMappings"] = {node_id: next(iter(mapping_value["nodeMappings"].values()))}
            mapping_value["edgeCorrespondence"] = []
            mapping = exact_json(mapping_value)
            if succeeds:
                result = parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)
                self.assertEqual(result.proof_dag.target_ids, (node_id,))
            else:
                with self.assertRaisesRegex(FormalProjectPackageError, r"nodes\[0\].id exceeds 512"):
                    parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

    def test_duplicate_nonfinite_and_size_bounds_fail_closed(self):
        raw, projected, mapping = conceptual_dag(), repository_field_dag(), correspondence()
        source = manifest(raw, projected, mapping)
        duplicate = source.decode().replace('"projectId":"leanproofs"', '"projectId":"leanproofs","projectId":"other"').encode()
        with self.assertRaisesRegex(FormalProjectPackageError, "Duplicate JSON fields"):
            parse_formal_project_package(duplicate, raw, projected, mapping)
        bad_mapping = mapping[:-1] + b',"ratio":1e9999}'
        with self.assertRaisesRegex(FormalProjectPackageError, "Non-finite JSON number"):
            parse_formal_project_package(manifest(raw, projected, bad_mapping), raw, projected, bad_mapping)
        with patch.object(package, "MAX_FORMAL_PROJECT_PACKAGE_BYTES", 8):
            with self.assertRaisesRegex(FormalProjectPackageError, "byte bound"):
                parse_formal_project_package(source, raw, projected, mapping)

    def test_manifest_roles_and_correspondence_top_level_are_exact(self):
        raw, projected, mapping = conceptual_dag(), repository_field_dag(), correspondence()
        source = json.loads(manifest(raw, projected, mapping))
        source["artifacts"]["authoredDag"] = source["artifacts"].pop("authoredConceptualDag")
        with self.assertRaisesRegex(FormalProjectPackageError, "authoredConceptualDag is required"):
            parse_formal_project_package(exact_json(source), raw, projected, mapping)
        mapping = correspondence(extra={"publication": {"status": "pending"}})
        with self.assertRaisesRegex(FormalProjectPackageError, "publication is not supported"):
            parse_formal_project_package(manifest(raw, projected, mapping), raw, projected, mapping)

    def test_signed_binary_envelope_preserves_exact_artifact_boundaries(self):
        raw, projected, mapping = conceptual_dag(), repository_field_dag(), correspondence()
        source = manifest(raw, projected, mapping)
        content = package_envelope(source, raw, projected, mapping)
        parsed = parse_formal_project_package_envelope(content)
        self.assertEqual(parsed.manifest_bytes, source)
        self.assertEqual(parsed.authored_conceptual_dag_bytes, raw)
        self.assertEqual(parsed.repository_field_dag_bytes, projected)
        self.assertEqual(parsed.correspondence_bytes, mapping)

        with self.assertRaisesRegex(FormalProjectPackageError, "magic"):
            parse_formal_project_package_envelope(b"BADMAGIC" + content[8:])
        with self.assertRaisesRegex(FormalProjectPackageError, "length is inconsistent"):
            parse_formal_project_package_envelope(content + b"x")
        empty_manifest = bytearray(content)
        empty_manifest[8:12] = (0).to_bytes(4, "big")
        with self.assertRaisesRegex(FormalProjectPackageError, "manifest exceeds"):
            parse_formal_project_package_envelope(bytes(empty_manifest))


if __name__ == "__main__":
    unittest.main()

"""Pure validation for immutable Rosetta formal-project packages.

This module deliberately has no persistence, routing, or coordination behavior.
It binds one exact package manifest to the materialized authored DAG and
authored/formal correspondence artifacts, then returns the already-passive
Galaxy proof-graph registration.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from proof_graph_registry import (
    MAX_PROOF_GRAPH_BYTES,
    ProofGraphRegistration,
    ProofGraphRegistryError,
    parse_proof_graph_bytes,
)


FORMAL_PROJECT_PACKAGE_SCHEMA = "rosetta.formal-project-package.v1"
AUTHORED_CONCEPTUAL_DAG_SCHEMA = "rosetta-authored-conceptual-dag/1.0.0"
CORRESPONDENCE_SCHEMA = "rosetta-authored-formal-correspondence/1.0.0"
CONVERSION_PROFILE = "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1"
MAX_FORMAL_PROJECT_PACKAGE_BYTES = 65_536
MAX_CORRESPONDENCE_BYTES = 16_777_216
MAX_JSON_DEPTH = 32
MAX_JSON_MEMBERS = 250_000
MAX_JSON_STRING_UTF16_UNITS = 16_384
MAX_NODE_MAPPINGS = 10_000
MAX_EDGE_CORRESPONDENCE = 50_000
MAX_BRIDGE_NOMINATIONS = 50_000
MAX_TEXT = 4_000
MAX_PATH_ITEMS = 2_000
MAX_COUNT_KEYS = 1_000
FORMAL_PROJECT_PACKAGE_ENVELOPE_MAGIC = b"GBFPP1\x00\x00"
FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER = struct.Struct(">8sIIII")
MAX_FORMAL_PROJECT_PACKAGE_ENVELOPE_BYTES = (
    FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.size
    + MAX_FORMAL_PROJECT_PACKAGE_BYTES
    + (2 * MAX_PROOF_GRAPH_BYTES)
    + MAX_CORRESPONDENCE_BYTES
)

SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$")
NODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$")

_MANIFEST_KEYS = {
    "schemaId", "projectId", "repository", "commit", "tree",
    "environment", "conversionProfile", "artifacts",
}
_ENVIRONMENT_KEYS = {"leanToolchain", "mathlibRevision"}
_ARTIFACT_ROLES = {
    "formalGraph": "jsonl",
    "repositoryGraph": "json",
    "authoredConceptualDag": "json",
    "repositoryFieldDag": "json",
    "correspondence": "json",
}
_DESCRIPTOR_KEYS = {"format", "sha256"}
_CONCEPTUAL_DAG_KEYS = {
    "schemaVersion", "generatedAt", "project", "revision", "source", "counts",
    "nodes", "edges", "claimBoundary",
}
_CONCEPTUAL_SOURCE_KEYS = {"path", "sha256", "parserProfile"}
_CONCEPTUAL_COUNTS_KEYS = {"nodes", "edges"}
_CONCEPTUAL_NODE_KEYS = {"id", "title", "description", "category", "rawLabel"}
_CONCEPTUAL_EDGE_KEYS = {"id", "source", "target", "semantics"}
_CONCEPTUAL_BOUNDARY_KEYS = {
    "authoredEdgesAreFormalDependencies", "authoredMathematicalClaimsVerified", "layer",
}
_SOURCE_REVISION_KEYS = {
    "repository", "commit", "tree", "lean_toolchain", "mathlib_revision",
}
_CORRESPONDENCE_KEYS = {
    "schemaVersion", "generatedAt", "project", "revision", "visibility",
    "mappingProfile", "counts", "nodeMappings", "edgeCorrespondence",
    "bridgeNominations", "claimBoundary",
}
_MAPPING_PROFILE_KEYS = {"rule", "cohortSemantics", "humanMappingsClaimed"}
_COUNTS_KEYS = {
    "formalDeclarations", "formalDependenciesWithinProject", "declarationKinds",
    "dependencyKinds", "dependenciesTargetingInstances", "authoredNodeMappings",
    "authoredEdgeClassifications",
}
_NODE_MAPPING_KEYS = {"status", "rule", "moduleCandidates", "formalDeclarations"}
_NODE_MAPPING_STATUSES = {
    "mapped",
    "ambiguous",
    "unmapped",
    "module-without-exported-declarations",
}
_EDGE_CORRESPONDENCE_KEYS = {
    "authoredEdge", "prerequisite", "dependent", "status", "supportKind",
    "formalPath", "formalEdgeKinds",
}
_BRIDGE_NOMINATION_KEYS = {"authoredEdge", "reason"}
_CLAIM_BOUNDARY_KEYS = {
    "moduleCohortMappingIsDeclarationEquivalence",
    "unsupportedEdgeIsMathematicallyFalse",
    "formalDependencyImpliesAuthoredInterpretation",
    "shortestPathsRestrictedToExportedLeanProofsDeclarations",
    "projectLocalAxiomPathStatusIsAxiomClosure",
    "externalLeanOrMathlibAxiomsClassified",
    "parallelDependencyPathsClassified",
    "proofTermsOrSourceTextSerialized",
}
_LIFECYCLE_FIELDS = {
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
}


class FormalProjectPackageError(ValueError):
    """The package or one of its materialized artifacts is invalid."""


@dataclass(frozen=True)
class FormalProjectArtifactDescriptor:
    format: str
    sha256: str


@dataclass(frozen=True)
class FormalProjectPackageProjection:
    manifest_bytes: bytes
    manifest_sha256: str
    project_id: str
    repository: str
    commit: str
    tree: str
    lean_toolchain: str
    mathlib_revision: str
    conversion_profile: str
    formal_graph: FormalProjectArtifactDescriptor
    repository_graph: FormalProjectArtifactDescriptor
    authored_conceptual_dag_descriptor: FormalProjectArtifactDescriptor
    repository_field_dag_descriptor: FormalProjectArtifactDescriptor
    correspondence_descriptor: FormalProjectArtifactDescriptor
    authored_conceptual_dag_bytes: bytes
    authored_conceptual_dag_sha256: str
    repository_field_dag_bytes: bytes
    repository_field_dag_sha256: str
    correspondence_bytes: bytes
    correspondence_sha256: str
    proof_dag: ProofGraphRegistration
    correspondence_schema: str


def parse_formal_project_package_envelope(
    content: bytes,
) -> FormalProjectPackageProjection:
    """Decode the signed binary transport without changing artifact bytes."""
    if not isinstance(content, bytes):
        raise FormalProjectPackageError("Formal project package envelope must be exact bytes")
    if not FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.size < len(content) <= MAX_FORMAL_PROJECT_PACKAGE_ENVELOPE_BYTES:
        raise FormalProjectPackageError("Formal project package envelope exceeds its byte bound")
    try:
        magic, manifest_length, authored_length, projection_length, correspondence_length = (
            FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.unpack_from(content)
        )
    except struct.error as error:
        raise FormalProjectPackageError("Formal project package envelope header is invalid") from error
    if magic != FORMAL_PROJECT_PACKAGE_ENVELOPE_MAGIC:
        raise FormalProjectPackageError("Formal project package envelope magic is invalid")
    lengths = (
        ("manifest", manifest_length, MAX_FORMAL_PROJECT_PACKAGE_BYTES),
        ("authored conceptual DAG", authored_length, MAX_PROOF_GRAPH_BYTES),
        ("repository field DAG", projection_length, MAX_PROOF_GRAPH_BYTES),
        ("correspondence", correspondence_length, MAX_CORRESPONDENCE_BYTES),
    )
    for label, length, maximum in lengths:
        if not 1 <= length <= maximum:
            raise FormalProjectPackageError(f"Formal project package {label} exceeds its byte bound")
    expected = FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.size + sum(length for _, length, _ in lengths)
    if len(content) != expected:
        raise FormalProjectPackageError("Formal project package envelope length is inconsistent")
    offset = FORMAL_PROJECT_PACKAGE_ENVELOPE_HEADER.size
    artifacts: list[bytes] = []
    for _, length, _ in lengths:
        artifacts.append(content[offset:offset + length])
        offset += length
    return parse_formal_project_package(*artifacts)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise FormalProjectPackageError("Duplicate JSON fields are not allowed")
        value[key] = item
    return value


def _reject_non_json_number(value: str):
    raise FormalProjectPackageError(f"Non-finite JSON number {value} is not allowed")


def _finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise FormalProjectPackageError(f"Non-finite JSON number {value} is not allowed")
    return parsed


def _load_json(content: bytes, label: str, maximum: int) -> Any:
    if not isinstance(content, bytes):
        raise FormalProjectPackageError(f"{label} must be exact bytes")
    if not 1 <= len(content) <= maximum:
        raise FormalProjectPackageError(f"{label} exceeds its byte bound")
    try:
        return json.loads(
            content.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
            parse_float=_finite_float,
        )
    except FormalProjectPackageError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise FormalProjectPackageError(f"{label} must be valid bounded UTF-8 JSON") from error


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FormalProjectPackageError(f"{label} must be an object")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    missing = expected - set(value)
    unknown = set(value) - expected
    if missing:
        raise FormalProjectPackageError(f"{label}.{sorted(missing)[0]} is required")
    if unknown:
        raise FormalProjectPackageError(f"{label}.{sorted(unknown)[0]} is not supported")


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise FormalProjectPackageError(f"{label} must be canonical non-empty text")
    try:
        length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise FormalProjectPackageError(f"{label} contains invalid Unicode") from error
    if length > maximum:
        raise FormalProjectPackageError(f"{label} exceeds {maximum} characters")
    return value


def _git_oid(value: Any, label: str) -> str:
    parsed = _text(value, label, 64)
    if not GIT_OID.fullmatch(parsed):
        raise FormalProjectPackageError(f"{label} must be a lowercase Git object ID")
    return parsed


def _sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise FormalProjectPackageError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _descriptor(value: Any, role: str, expected_format: str) -> FormalProjectArtifactDescriptor:
    source = _object(value, f"Package artifact {role}")
    _exact_keys(source, _DESCRIPTOR_KEYS, f"Package artifact {role}")
    if source["format"] != expected_format:
        raise FormalProjectPackageError(
            f"Package artifact {role} format must be {expected_format}"
        )
    return FormalProjectArtifactDescriptor(
        format=expected_format,
        sha256=_sha256(source["sha256"], f"Package artifact {role} sha256"),
    )


def _bounded_structure(value: Any, label: str) -> None:
    members = 0
    pending = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise FormalProjectPackageError(f"{label} exceeds the JSON depth bound")
        if isinstance(current, dict):
            members += len(current)
            pending.extend((item, depth + 1) for item in current.values())
            for key in current:
                _text(key, f"{label} field name", MAX_JSON_STRING_UTF16_UNITS)
        elif isinstance(current, list):
            members += len(current)
            pending.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            try:
                length = len(current.encode("utf-16-le")) // 2
            except UnicodeEncodeError as error:
                raise FormalProjectPackageError(f"{label} contains invalid Unicode") from error
            if length > MAX_JSON_STRING_UTF16_UNITS:
                raise FormalProjectPackageError(f"{label} text exceeds its size bound")
        if members > MAX_JSON_MEMBERS:
            raise FormalProjectPackageError(f"{label} exceeds the JSON member bound")


def _normalized_field(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _reject_live_state(value: Any, label: str, *, correspondence: bool = False) -> None:
    pending: list[tuple[Any, tuple[str, ...], str]] = [(value, (), "")]
    while pending:
        current, path, parent_key = pending.pop()
        if isinstance(current, dict):
            for key, child in current.items():
                normalized = _normalized_field(key)
                if normalized in _LIFECYCLE_FIELDS:
                    raise FormalProjectPackageError(
                        f"{label}.{'.'.join(path + (key,))} contains live lifecycle state"
                    )
                if (
                    normalized == "status"
                    and not correspondence
                    and _normalized_field(parent_key) not in {
                        "formalbinding", "formalcorrespondence",
                    }
                ):
                    raise FormalProjectPackageError(
                        f"{label}.{'.'.join(path + (key,))} contains live status state"
                    )
                pending.append((child, path + (key,), key))
        elif isinstance(current, list):
            pending.extend(
                (child, path + (str(index),), parent_key)
                for index, child in enumerate(current)
            )


def _verify_materialized_digest(
    content: bytes, descriptor: FormalProjectArtifactDescriptor, label: str,
) -> str:
    if not isinstance(content, bytes):
        raise FormalProjectPackageError(f"{label} must be exact bytes")
    digest = hashlib.sha256(content).hexdigest()
    if digest != descriptor.sha256:
        raise FormalProjectPackageError(f"{label} SHA-256 does not match the package manifest")
    return digest


def _nonnegative_integer(value: Any, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > 9_007_199_254_740_991
    ):
        raise FormalProjectPackageError(f"{label} must be a non-negative integer")
    return value


def _string_array(value: Any, label: str, maximum: int = MAX_PATH_ITEMS) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise FormalProjectPackageError(f"{label} must contain at most {maximum} entries")
    return [_text(item, f"{label}[{index}]", MAX_TEXT) for index, item in enumerate(value)]


def _optional_text(value: Any, label: str, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or value != value.strip():
        raise FormalProjectPackageError(f"{label} must be canonical text")
    if len(value.encode("utf-16-le")) // 2 > maximum:
        raise FormalProjectPackageError(f"{label} exceeds {maximum} characters")
    return value


def _timestamp(value: Any, label: str) -> str:
    parsed = _text(value, label, 200)
    try:
        datetime.fromisoformat(parsed.replace("Z", "+00:00"))
    except ValueError as error:
        raise FormalProjectPackageError(f"{label} must be an ISO timestamp") from error
    return parsed


def _validate_authored_conceptual_dag(
    value: dict[str, Any], project_id: str, commit: str,
) -> tuple[set[str], dict[str, tuple[str, str]]]:
    _exact_keys(value, _CONCEPTUAL_DAG_KEYS, "Authored conceptual DAG")
    if value["schemaVersion"] != AUTHORED_CONCEPTUAL_DAG_SCHEMA:
        raise FormalProjectPackageError(
            f"Authored conceptual DAG must use {AUTHORED_CONCEPTUAL_DAG_SCHEMA}"
        )
    if value["project"] != project_id:
        raise FormalProjectPackageError(
            "Authored conceptual DAG project does not match package projectId"
        )
    if value["revision"] != commit:
        raise FormalProjectPackageError(
            "Authored conceptual DAG revision does not match package commit"
        )
    _timestamp(value["generatedAt"], "Authored conceptual DAG generatedAt")

    source = _object(value["source"], "Authored conceptual DAG source")
    _exact_keys(source, _CONCEPTUAL_SOURCE_KEYS, "Authored conceptual DAG source")
    _text(source["path"], "Authored conceptual DAG source.path", 1_000)
    _sha256(source["sha256"], "Authored conceptual DAG source.sha256")
    _text(source["parserProfile"], "Authored conceptual DAG source.parserProfile", 500)

    counts = _object(value["counts"], "Authored conceptual DAG counts")
    _exact_keys(counts, _CONCEPTUAL_COUNTS_KEYS, "Authored conceptual DAG counts")
    node_count = _nonnegative_integer(counts["nodes"], "Authored conceptual DAG counts.nodes")
    edge_count = _nonnegative_integer(counts["edges"], "Authored conceptual DAG counts.edges")
    nodes = value["nodes"]
    edges = value["edges"]
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODE_MAPPINGS:
        raise FormalProjectPackageError(
            f"Authored conceptual DAG nodes must contain 1 to {MAX_NODE_MAPPINGS} entries"
        )
    if not isinstance(edges, list) or len(edges) > MAX_EDGE_CORRESPONDENCE:
        raise FormalProjectPackageError(
            f"Authored conceptual DAG edges must contain at most {MAX_EDGE_CORRESPONDENCE} entries"
        )
    if node_count != len(nodes) or edge_count != len(edges):
        raise FormalProjectPackageError(
            "Authored conceptual DAG counts must match its node and edge arrays"
        )

    node_ids: set[str] = set()
    for index, raw in enumerate(nodes):
        label = f"Authored conceptual DAG nodes[{index}]"
        node = _object(raw, label)
        _exact_keys(node, _CONCEPTUAL_NODE_KEYS, label)
        node_id = _text(node["id"], f"{label}.id", 512)
        if not NODE_ID.fullmatch(node_id):
            raise FormalProjectPackageError(f"{label}.id is invalid")
        if node_id in node_ids:
            raise FormalProjectPackageError(f"Authored conceptual DAG node {node_id} is duplicated")
        node_ids.add(node_id)
        _text(node["title"], f"{label}.title", 500)
        _optional_text(node["description"], f"{label}.description")
        _text(node["category"], f"{label}.category", 120)
        _text(node["rawLabel"], f"{label}.rawLabel", MAX_TEXT)

    edge_by_id: dict[str, tuple[str, str]] = {}
    for index, raw in enumerate(edges):
        label = f"Authored conceptual DAG edges[{index}]"
        edge = _object(raw, label)
        _exact_keys(edge, _CONCEPTUAL_EDGE_KEYS, label)
        edge_id = _text(edge["id"], f"{label}.id", 512)
        if edge_id in edge_by_id:
            raise FormalProjectPackageError(f"Authored conceptual DAG edge {edge_id} is duplicated")
        endpoints = []
        for name in ("source", "target"):
            endpoint = _text(edge[name], f"{label}.{name}", 512)
            if not NODE_ID.fullmatch(endpoint):
                raise FormalProjectPackageError(f"{label}.{name} is invalid")
            endpoints.append(endpoint)
        if any(endpoint not in node_ids for endpoint in endpoints):
            raise FormalProjectPackageError(
                f"Authored conceptual DAG edge {edge_id} references a missing node"
            )
        if endpoints[0] == endpoints[1]:
            raise FormalProjectPackageError(
                f"Authored conceptual DAG edge {edge_id} cannot be self-referential"
            )
        if edge["semantics"] != "authored-prerequisite-to-dependent":
            raise FormalProjectPackageError(
                f"{label}.semantics must be authored-prerequisite-to-dependent"
            )
        edge_by_id[edge_id] = (endpoints[0], endpoints[1])

    boundary = _object(value["claimBoundary"], "Authored conceptual DAG claimBoundary")
    _exact_keys(boundary, _CONCEPTUAL_BOUNDARY_KEYS, "Authored conceptual DAG claimBoundary")
    if boundary["authoredEdgesAreFormalDependencies"] is not False:
        raise FormalProjectPackageError(
            "Authored conceptual DAG cannot claim authored edges are formal dependencies"
        )
    if boundary["authoredMathematicalClaimsVerified"] is not False:
        raise FormalProjectPackageError(
            "Authored conceptual DAG cannot claim authored mathematical claims are verified"
        )
    if boundary["layer"] != "hypothesis-and-interpretation":
        raise FormalProjectPackageError("Authored conceptual DAG claimBoundary.layer is invalid")
    return node_ids, edge_by_id


def _count_map(value: Any, label: str) -> None:
    source = _object(value, label)
    if len(source) > MAX_COUNT_KEYS:
        raise FormalProjectPackageError(f"{label} exceeds {MAX_COUNT_KEYS} entries")
    for key, count in source.items():
        _text(key, f"{label} key", 200)
        _nonnegative_integer(count, f"{label}.{key}")


def _validate_correspondence(value: dict[str, Any], project_id: str, commit: str) -> None:
    _exact_keys(value, _CORRESPONDENCE_KEYS, "Correspondence")
    if value["schemaVersion"] != CORRESPONDENCE_SCHEMA:
        raise FormalProjectPackageError(f"Correspondence must use {CORRESPONDENCE_SCHEMA}")
    if value["project"] != project_id:
        raise FormalProjectPackageError("Correspondence project does not match the package")
    if value["revision"] != commit:
        raise FormalProjectPackageError("Correspondence revision does not match the package commit")
    _timestamp(value["generatedAt"], "Correspondence generatedAt")
    _text(value["visibility"], "Correspondence visibility", 80)

    profile = _object(value["mappingProfile"], "Correspondence mappingProfile")
    _exact_keys(profile, _MAPPING_PROFILE_KEYS, "Correspondence mappingProfile")
    _text(profile["rule"], "Correspondence mappingProfile.rule", 500)
    _text(profile["cohortSemantics"], "Correspondence mappingProfile.cohortSemantics", MAX_TEXT)
    if not isinstance(profile["humanMappingsClaimed"], bool):
        raise FormalProjectPackageError(
            "Correspondence mappingProfile.humanMappingsClaimed must be boolean"
        )

    counts = _object(value["counts"], "Correspondence counts")
    _exact_keys(counts, _COUNTS_KEYS, "Correspondence counts")
    for name in (
        "formalDeclarations", "formalDependenciesWithinProject",
        "dependenciesTargetingInstances",
    ):
        _nonnegative_integer(counts[name], f"Correspondence counts.{name}")
    for name in (
        "declarationKinds", "dependencyKinds", "authoredNodeMappings",
        "authoredEdgeClassifications",
    ):
        _count_map(counts[name], f"Correspondence counts.{name}")

    node_mappings = _object(value["nodeMappings"], "Correspondence nodeMappings")
    if len(node_mappings) > MAX_NODE_MAPPINGS:
        raise FormalProjectPackageError(
            f"Correspondence nodeMappings exceeds {MAX_NODE_MAPPINGS} entries"
        )
    for node_id, raw in node_mappings.items():
        if not NODE_ID.fullmatch(node_id):
            raise FormalProjectPackageError("Correspondence nodeMappings key is invalid")
        mapping = _object(raw, f"Correspondence nodeMappings.{node_id}")
        _exact_keys(mapping, _NODE_MAPPING_KEYS, f"Correspondence nodeMappings.{node_id}")
        status = _text(
            mapping["status"], f"Correspondence nodeMappings.{node_id}.status", 120,
        )
        if status not in _NODE_MAPPING_STATUSES:
            raise FormalProjectPackageError(
                f"Correspondence nodeMappings.{node_id}.status is not an authored mapping classification"
            )
        _text(mapping["rule"], f"Correspondence nodeMappings.{node_id}.rule", 500)
        _string_array(
            mapping["moduleCandidates"],
            f"Correspondence nodeMappings.{node_id}.moduleCandidates",
        )
        _string_array(
            mapping["formalDeclarations"],
            f"Correspondence nodeMappings.{node_id}.formalDeclarations",
        )

    edge_correspondence = value["edgeCorrespondence"]
    if not isinstance(edge_correspondence, list) or len(edge_correspondence) > MAX_EDGE_CORRESPONDENCE:
        raise FormalProjectPackageError(
            f"Correspondence edgeCorrespondence must contain at most {MAX_EDGE_CORRESPONDENCE} entries"
        )
    for index, raw in enumerate(edge_correspondence):
        label = f"Correspondence edgeCorrespondence[{index}]"
        edge = _object(raw, label)
        _exact_keys(edge, _EDGE_CORRESPONDENCE_KEYS, label)
        _text(edge["authoredEdge"], f"{label}.authoredEdge", 512)
        for name in ("prerequisite", "dependent"):
            identifier = _text(edge[name], f"{label}.{name}", 512)
            if not NODE_ID.fullmatch(identifier):
                raise FormalProjectPackageError(f"{label}.{name} is invalid")
        _text(edge["status"], f"{label}.status", 120)
        if edge["supportKind"] is not None:
            _text(edge["supportKind"], f"{label}.supportKind", 120)
        if edge["formalPath"] is not None:
            _string_array(edge["formalPath"], f"{label}.formalPath")
        kinds = edge["formalEdgeKinds"]
        if not isinstance(kinds, list) or len(kinds) > MAX_PATH_ITEMS:
            raise FormalProjectPackageError(
                f"{label}.formalEdgeKinds must contain at most {MAX_PATH_ITEMS} entries"
            )
        for step, item in enumerate(kinds):
            _string_array(item, f"{label}.formalEdgeKinds[{step}]", 100)

    nominations = value["bridgeNominations"]
    if not isinstance(nominations, list) or len(nominations) > MAX_BRIDGE_NOMINATIONS:
        raise FormalProjectPackageError(
            f"Correspondence bridgeNominations must contain at most {MAX_BRIDGE_NOMINATIONS} entries"
        )
    for index, raw in enumerate(nominations):
        label = f"Correspondence bridgeNominations[{index}]"
        nomination = _object(raw, label)
        _exact_keys(nomination, _BRIDGE_NOMINATION_KEYS, label)
        _text(nomination["authoredEdge"], f"{label}.authoredEdge", 512)
        _text(nomination["reason"], f"{label}.reason", 500)

    boundary = _object(value["claimBoundary"], "Correspondence claimBoundary")
    _exact_keys(boundary, _CLAIM_BOUNDARY_KEYS, "Correspondence claimBoundary")
    for name in _CLAIM_BOUNDARY_KEYS:
        if not isinstance(boundary[name], bool):
            raise FormalProjectPackageError(
                f"Correspondence claimBoundary.{name} must be boolean"
            )


def _bind_correspondence_to_dag(
    correspondence: dict[str, Any], node_ids: set[str],
    edges: dict[str, tuple[str, str]],
) -> None:
    """Require correspondence to describe exactly the raw authored DAG."""
    mapping_ids = set(correspondence["nodeMappings"])
    if mapping_ids != node_ids:
        raise FormalProjectPackageError(
            "Correspondence nodeMappings do not match the authored conceptual DAG nodes"
        )
    correspondence_edges: dict[str, tuple[str, str]] = {}
    for item in correspondence["edgeCorrespondence"]:
        edge_id = item["authoredEdge"]
        if edge_id in correspondence_edges:
            raise FormalProjectPackageError(
                f"Correspondence authored edge {edge_id} is duplicated"
            )
        correspondence_edges[edge_id] = (item["prerequisite"], item["dependent"])
    if set(correspondence_edges) != set(edges):
        raise FormalProjectPackageError(
            "Correspondence edges do not match the authored DAG relations"
        )
    for edge_id, endpoints in correspondence_edges.items():
        if endpoints != edges[edge_id]:
            raise FormalProjectPackageError(
                f"Correspondence edge {edge_id} endpoints do not match the authored DAG"
            )

    nominations: set[str] = set()
    for item in correspondence["bridgeNominations"]:
        edge_id = item["authoredEdge"]
        if edge_id not in edges:
            raise FormalProjectPackageError(
                f"Correspondence bridge nomination {edge_id} is not an authored DAG relation"
            )
        if edge_id in nominations:
            raise FormalProjectPackageError(
                f"Correspondence bridge nomination {edge_id} is duplicated"
            )
        nominations.add(edge_id)


def _bind_formal_mapping_classifications(
    correspondence: dict[str, Any], proof_dag: ProofGraphRegistration,
) -> None:
    """Keep projected mapping classifications passive and producer-derived."""
    mappings = correspondence["nodeMappings"]
    for target in proof_dag.artifact["targets"]:
        binding = target.get("formal_binding")
        if not isinstance(binding, dict) or "status" not in binding:
            continue
        target_id = target["target_id"]
        status = binding["status"]
        if not isinstance(status, str) or status not in _NODE_MAPPING_STATUSES:
            raise FormalProjectPackageError(
                f"Repository-field DAG target {target_id} formal_binding.status "
                "is not an authored mapping classification"
            )
        if status != mappings[target_id]["status"]:
            raise FormalProjectPackageError(
                f"Repository-field DAG target {target_id} formal_binding.status "
                "does not match correspondence nodeMappings status"
            )


def _validate_repository_field_dag(
    value: dict[str, Any], content: bytes, *, repository: str, commit: str,
    tree: str, lean_toolchain: str, mathlib_revision: str,
    node_ids: set[str], edges: dict[str, tuple[str, str]],
) -> ProofGraphRegistration:
    _reject_live_state(value, "Repository-field DAG")
    if value.get("graph_kind") != "repository-field":
        raise FormalProjectPackageError("Repository-field DAG must be passive")
    revision = _object(value.get("source_revision"), "Repository-field DAG source_revision")
    _exact_keys(revision, _SOURCE_REVISION_KEYS, "Repository-field DAG source_revision")
    expected = {
        "repository": repository,
        "commit": commit,
        "tree": tree,
        "lean_toolchain": lean_toolchain,
        "mathlib_revision": mathlib_revision,
    }
    for name, expected_value in expected.items():
        if revision[name] != expected_value:
            raise FormalProjectPackageError(
                f"Repository-field DAG source_revision.{name} does not match the package manifest"
            )
    try:
        proof_dag = parse_proof_graph_bytes(content)
    except ProofGraphRegistryError as error:
        raise FormalProjectPackageError(f"Repository-field DAG is invalid: {error}") from error

    if set(proof_dag.target_ids) != node_ids:
        raise FormalProjectPackageError(
            "Repository-field DAG targets do not match authored conceptual DAG nodes"
        )
    projected: dict[str, tuple[str, str]] = {}
    for relation in proof_dag.artifact["relations"]:
        relation_id = relation["relation_id"]
        if relation_id in projected:
            raise FormalProjectPackageError(
                f"Repository-field DAG relation {relation_id} is duplicated"
            )
        if relation.get("relation_type") != "AUTHORED_PREREQUISITE":
            raise FormalProjectPackageError(
                f"Repository-field DAG relation {relation_id} is not an authored prerequisite"
            )
        projected[relation_id] = (
            relation["prerequisite_target_id"], relation["dependent_target_id"],
        )
    if set(projected) != set(edges):
        raise FormalProjectPackageError(
            "Repository-field DAG relations do not match authored conceptual DAG edges"
        )
    for edge_id, endpoints in projected.items():
        if endpoints != edges[edge_id]:
            raise FormalProjectPackageError(
                f"Repository-field DAG relation {edge_id} endpoints do not match the authored conceptual DAG"
            )
    return proof_dag


def parse_formal_project_package(
    manifest_bytes: bytes,
    authored_conceptual_dag_bytes: bytes,
    repository_field_dag_bytes: bytes,
    correspondence_bytes: bytes,
) -> FormalProjectPackageProjection:
    """Validate a package without persisting or activating any contained graph."""
    manifest = _object(
        _load_json(
            manifest_bytes, "Formal project package manifest", MAX_FORMAL_PROJECT_PACKAGE_BYTES,
        ),
        "Formal project package manifest",
    )
    _exact_keys(manifest, _MANIFEST_KEYS, "Formal project package manifest")
    if manifest["schemaId"] != FORMAL_PROJECT_PACKAGE_SCHEMA:
        raise FormalProjectPackageError(
            f"Formal project package manifest must use {FORMAL_PROJECT_PACKAGE_SCHEMA}"
        )
    if manifest["conversionProfile"] != CONVERSION_PROFILE:
        raise FormalProjectPackageError(
            f"Formal project package conversionProfile must be {CONVERSION_PROFILE}"
        )
    _bounded_structure(manifest, "Formal project package manifest")
    _reject_live_state(manifest, "Formal project package manifest")

    project_id = _text(manifest["projectId"], "Package projectId", 512)
    if not PROJECT_ID.fullmatch(project_id):
        raise FormalProjectPackageError("Package projectId is invalid")
    repository = _text(manifest["repository"], "Package repository", 500)
    commit = _git_oid(manifest["commit"], "Package commit")
    tree = _git_oid(manifest["tree"], "Package tree")

    environment = _object(manifest["environment"], "Package environment")
    _exact_keys(environment, _ENVIRONMENT_KEYS, "Package environment")
    lean_toolchain = _text(
        environment["leanToolchain"], "Package environment leanToolchain", 200,
    )
    mathlib_revision = _git_oid(
        environment["mathlibRevision"], "Package environment mathlibRevision",
    )

    artifacts = _object(manifest["artifacts"], "Package artifacts")
    _exact_keys(artifacts, set(_ARTIFACT_ROLES), "Package artifacts")
    descriptors = {
        role: _descriptor(artifacts[role], role, expected_format)
        for role, expected_format in _ARTIFACT_ROLES.items()
    }

    authored_digest = _verify_materialized_digest(
        authored_conceptual_dag_bytes, descriptors["authoredConceptualDag"],
        "Authored conceptual DAG",
    )
    repository_field_digest = _verify_materialized_digest(
        repository_field_dag_bytes, descriptors["repositoryFieldDag"],
        "Repository-field DAG",
    )
    correspondence_digest = _verify_materialized_digest(
        correspondence_bytes, descriptors["correspondence"], "Correspondence",
    )

    authored_value = _object(
        _load_json(
            authored_conceptual_dag_bytes, "Authored conceptual DAG", MAX_PROOF_GRAPH_BYTES,
        ),
        "Authored conceptual DAG",
    )
    _bounded_structure(authored_value, "Authored conceptual DAG")
    _reject_live_state(authored_value, "Authored conceptual DAG")
    node_ids, edges = _validate_authored_conceptual_dag(authored_value, project_id, commit)

    repository_field_value = _object(
        _load_json(
            repository_field_dag_bytes, "Repository-field DAG", MAX_PROOF_GRAPH_BYTES,
        ),
        "Repository-field DAG",
    )
    _bounded_structure(repository_field_value, "Repository-field DAG")
    proof_dag = _validate_repository_field_dag(
        repository_field_value,
        repository_field_dag_bytes,
        repository=repository,
        commit=commit,
        tree=tree,
        lean_toolchain=lean_toolchain,
        mathlib_revision=mathlib_revision,
        node_ids=node_ids,
        edges=edges,
    )

    correspondence = _object(
        _load_json(correspondence_bytes, "Correspondence", MAX_CORRESPONDENCE_BYTES),
        "Correspondence",
    )
    _bounded_structure(correspondence, "Correspondence")
    _reject_live_state(correspondence, "Correspondence", correspondence=True)
    _validate_correspondence(correspondence, project_id, commit)
    _bind_correspondence_to_dag(correspondence, node_ids, edges)
    _bind_formal_mapping_classifications(correspondence, proof_dag)

    return FormalProjectPackageProjection(
        manifest_bytes=manifest_bytes,
        manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        project_id=project_id,
        repository=repository,
        commit=commit,
        tree=tree,
        lean_toolchain=lean_toolchain,
        mathlib_revision=mathlib_revision,
        conversion_profile=CONVERSION_PROFILE,
        formal_graph=descriptors["formalGraph"],
        repository_graph=descriptors["repositoryGraph"],
        authored_conceptual_dag_descriptor=descriptors["authoredConceptualDag"],
        repository_field_dag_descriptor=descriptors["repositoryFieldDag"],
        correspondence_descriptor=descriptors["correspondence"],
        authored_conceptual_dag_bytes=authored_conceptual_dag_bytes,
        authored_conceptual_dag_sha256=authored_digest,
        repository_field_dag_bytes=repository_field_dag_bytes,
        repository_field_dag_sha256=repository_field_digest,
        correspondence_bytes=correspondence_bytes,
        correspondence_sha256=correspondence_digest,
        proof_dag=proof_dag,
        correspondence_schema=CORRESPONDENCE_SCHEMA,
    )

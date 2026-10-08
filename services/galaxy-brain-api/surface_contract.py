"""Canonical bounded generative-surface contract for the Galaxy Brain API.

The checked-in JSON manifest is the source of truth for the envelope bounds,
approved bindings, renderer identity, and per-component prop schemas. Importing
this module fails closed if either manifest digest or a prop schema is invalid.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Dict

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

CONTRACT_PATH = Path(__file__).with_name("contracts") / "gb.surface.v1.json"


class SurfaceContractError(ValueError):
    """Raised when a contract or proposed surface is outside the bounded model."""


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_contract_manifest() -> dict:
    try:
        manifest = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"surface contract cannot be loaded: {CONTRACT_PATH}") from error

    if not isinstance(manifest, dict) or set(manifest) != {
        "format",
        "manifestVersion",
        "schema",
        "catalog",
        "digests",
    }:
        raise RuntimeError("surface contract manifest has an invalid envelope")
    if manifest["format"] != "galaxy.surface-contract" or manifest["manifestVersion"] != 1:
        raise RuntimeError("surface contract manifest version is unsupported")

    digests = manifest.get("digests")
    if not isinstance(digests, dict) or digests.get("algorithm") != "sha256":
        raise RuntimeError("surface contract digest declaration is invalid")
    for section in ("schema", "catalog"):
        expected = digests.get(section)
        actual = _canonical_digest(manifest.get(section))
        if expected != actual:
            raise RuntimeError(
                f"surface contract {section} digest mismatch: expected {expected}, computed {actual}"
            )

    schema = manifest.get("schema")
    catalog = manifest.get("catalog")
    if not isinstance(schema, dict) or not isinstance(catalog, dict):
        raise RuntimeError("surface contract schema and catalog must be objects")
    bounds = schema.get("bounds")
    if not isinstance(bounds, dict) or any(
        not isinstance(bounds.get(name), int) or bounds[name] <= 0
        for name in (
            "maxComponents",
            "maxBindings",
            "maxJsonBytes",
            "maxStringLength",
            "maxDepth",
            "maxValueNodes",
        )
    ):
        raise RuntimeError("surface contract bounds are invalid")

    components = catalog.get("components")
    binding_kinds = catalog.get("bindingKinds")
    renderer = catalog.get("renderer")
    if not isinstance(components, dict) or not components:
        raise RuntimeError("surface contract component catalog is empty")
    if not isinstance(binding_kinds, dict) or not binding_kinds:
        raise RuntimeError("surface contract binding catalog is empty")
    if not isinstance(renderer, dict) or not all(
        isinstance(renderer.get(key), str) and renderer[key]
        for key in ("id", "version")
    ):
        raise RuntimeError("surface contract renderer identity is invalid")

    for component_type, declaration in components.items():
        if not isinstance(component_type, str) or not isinstance(declaration, dict):
            raise RuntimeError("surface contract component declaration is invalid")
        if set(declaration) != {"description", "bindingTargets", "propsSchema"}:
            raise RuntimeError(f"surface contract declaration is invalid: {component_type}")
        if not isinstance(declaration["description"], str) or not declaration["description"]:
            raise RuntimeError(f"surface contract description is missing: {component_type}")
        if not isinstance(declaration["bindingTargets"], list) or any(
            not isinstance(target, str) for target in declaration["bindingTargets"]
        ):
            raise RuntimeError(f"surface contract binding targets are invalid: {component_type}")
        try:
            Draft202012Validator.check_schema(declaration["propsSchema"])
        except SchemaError as error:
            raise RuntimeError(
                f"surface contract prop schema is invalid: {component_type}: {error.message}"
            ) from error

    for binding_kind, declaration in binding_kinds.items():
        selectors = declaration.get("selectors") if isinstance(declaration, dict) else None
        if (
            not isinstance(binding_kind, str)
            or not isinstance(declaration, dict)
            or not isinstance(selectors, list)
            or not selectors
            or any(selector not in {"resourceId", "query"} for selector in selectors)
            or set(declaration) != {"selectors", *(f"{selector}Schema" for selector in selectors)}
        ):
            raise RuntimeError(f"surface contract binding kind is invalid: {binding_kind}")
        for selector in selectors:
            try:
                Draft202012Validator.check_schema(declaration[f"{selector}Schema"])
            except SchemaError as error:
                raise RuntimeError(
                    f"surface contract binding selector schema is invalid: {binding_kind}.{selector}: {error.message}"
                ) from error

    return manifest


CONTRACT_MANIFEST = _load_contract_manifest()
SCHEMA_DECLARATION = CONTRACT_MANIFEST["schema"]
CATALOG_DECLARATION = CONTRACT_MANIFEST["catalog"]
SURFACE_SCHEMA = SCHEMA_DECLARATION["id"]
CATALOG_ID = CATALOG_DECLARATION["id"]
CATALOG_VERSION = CATALOG_DECLARATION["version"]
SCHEMA_DIGEST = CONTRACT_MANIFEST["digests"]["schema"]
CATALOG_DIGEST = CONTRACT_MANIFEST["digests"]["catalog"]
RENDERER_VERSION = CATALOG_DECLARATION["renderer"]["version"]

BOUNDS = SCHEMA_DECLARATION["bounds"]
MAX_COMPONENTS = BOUNDS["maxComponents"]
MAX_BINDINGS = BOUNDS["maxBindings"]
MAX_JSON_BYTES = BOUNDS["maxJsonBytes"]
MAX_STRING_LENGTH = BOUNDS["maxStringLength"]
MAX_DEPTH = BOUNDS["maxDepth"]
MAX_VALUE_NODES = BOUNDS["maxValueNodes"]

IDENTIFIER_PATTERN = re.compile(SCHEMA_DECLARATION["identifierPattern"])
ACTION_KEY_PATTERN = re.compile(SCHEMA_DECLARATION["forbiddenPropertyPattern"])
FORBIDDEN_PROPERTY_NAMES = frozenset(
    name.lower() for name in SCHEMA_DECLARATION["forbiddenPropertyNames"]
)
FORBIDDEN_STRING_FRAGMENTS = tuple(
    fragment.lower() for fragment in SCHEMA_DECLARATION["forbiddenStringFragments"]
)
APPROVED_COMPONENT_TYPES = frozenset(CATALOG_DECLARATION["components"])
APPROVED_BINDING_KINDS = frozenset(CATALOG_DECLARATION["bindingKinds"])
COMPONENT_VALIDATORS = {
    component_type: Draft202012Validator(declaration["propsSchema"])
    for component_type, declaration in CATALOG_DECLARATION["components"].items()
}
BINDING_SELECTOR_VALIDATORS = {
    binding_kind: {
        selector: Draft202012Validator(declaration[f"{selector}Schema"])
        for selector in declaration["selectors"]
    }
    for binding_kind, declaration in CATALOG_DECLARATION["bindingKinds"].items()
}


def get_surface_contract_manifest() -> dict:
    """Return a detached copy safe to serialize through the API."""
    return json.loads(json.dumps(CONTRACT_MANIFEST, ensure_ascii=False, allow_nan=False))


def surface_contract_identity() -> dict[str, str]:
    """Return the immutable identity persisted with each surface revision."""
    return {
        "schema_version": SURFACE_SCHEMA,
        "schema_digest": SCHEMA_DIGEST,
        "catalog_id": CATALOG_ID,
        "catalog_version": CATALOG_VERSION,
        "catalog_digest": CATALOG_DIGEST,
        "renderer_version": RENDERER_VERSION,
    }


def _require_identifier(value: Any, path: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.fullmatch(value):
        raise SurfaceContractError(f"{path} must be a stable identifier")
    return value


def _validate_bounded_value(value: Any, path: str, depth: int, counter: list[int]) -> None:
    if depth > MAX_DEPTH:
        raise SurfaceContractError(f"{path} exceeds the maximum nesting depth")
    counter[0] += 1
    if counter[0] > MAX_VALUE_NODES:
        raise SurfaceContractError("surface contains too many values")

    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SurfaceContractError(f"{path} contains a non-finite number")
        return
    if isinstance(value, str):
        if len(value) > MAX_STRING_LENGTH:
            raise SurfaceContractError(f"{path} exceeds the maximum string length")
        if any(fragment in value.lower() for fragment in FORBIDDEN_STRING_FRAGMENTS):
            raise SurfaceContractError(f"{path} contains executable content")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_bounded_value(item, f"{path}[{index}]", depth + 1, counter)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise SurfaceContractError(f"{path} contains a non-string property")
            if ACTION_KEY_PATTERN.match(key) or key.lower() in FORBIDDEN_PROPERTY_NAMES:
                raise SurfaceContractError(f"{path}.{key} is not allowed in a promotable surface")
            _validate_bounded_value(item, f"{path}.{key}", depth + 1, counter)
        return
    raise SurfaceContractError(f"{path} contains an unsupported value")


def _validate_component_props(component_type: str, props: dict, path: str) -> None:
    errors = sorted(
        COMPONENT_VALIDATORS[component_type].iter_errors(props),
        key=lambda error: list(error.absolute_path),
    )
    if not errors:
        return
    error = errors[0]
    suffix = "".join(
        f"[{part}]" if isinstance(part, int) else f".{part}" for part in error.absolute_path
    )
    raise SurfaceContractError(f"{path}{suffix}: {error.message}")


def validate_binding_source(
    source: Any,
    path: str = "binding.source",
    counter: list[int] | None = None,
) -> dict:
    if not isinstance(source, dict) or set(source) - {"kind", "resourceId", "query"}:
        raise SurfaceContractError(f"{path} is invalid")
    source_kind = source.get("kind")
    if not isinstance(source_kind, str) or source_kind not in APPROVED_BINDING_KINDS:
        raise SurfaceContractError(f"{path}.kind is not approved")
    selectors = CATALOG_DECLARATION["bindingKinds"][source_kind]["selectors"]
    present_selectors = [selector for selector in selectors if selector in source]
    if len(present_selectors) != 1 or set(source) != {"kind", present_selectors[0]}:
        raise SurfaceContractError(f"{path} requires exactly one approved selector")
    _validate_bounded_value(source, path, 0, counter if counter is not None else [0])
    selector = present_selectors[0]
    errors = sorted(
        BINDING_SELECTOR_VALIDATORS[source_kind][selector].iter_errors(source[selector]),
        key=lambda error: list(error.absolute_path),
    )
    if errors:
        error = errors[0]
        suffix = "".join(
            f"[{part}]" if isinstance(part, int) else f".{part}"
            for part in error.absolute_path
        )
        raise SurfaceContractError(f"{path}.{selector}{suffix}: {error.message}")
    return source


def _assert_acyclic(children_by_id: Dict[str, list[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(component_id: str) -> None:
        if component_id in visiting:
            raise SurfaceContractError("component references contain a cycle")
        if component_id in visited:
            return
        visiting.add(component_id)
        for child_id in children_by_id.get(component_id, []):
            visit(child_id)
        visiting.remove(component_id)
        visited.add(component_id)

    for component_id in children_by_id:
        visit(component_id)


def validate_surface_spec(value: Any) -> dict:
    """Validate and return a detached JSON-compatible surface specification."""
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise SurfaceContractError("surface must be finite, JSON-serializable data") from error
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise SurfaceContractError("surface exceeds the maximum encoded size")

    if not isinstance(value, dict):
        raise SurfaceContractError("surface must be an object")
    if set(value) != set(SCHEMA_DECLARATION["topLevelProperties"]):
        raise SurfaceContractError("surface must contain exactly the approved top-level properties")
    if value.get("schema") != SURFACE_SCHEMA:
        raise SurfaceContractError(f"surface schema must be {SURFACE_SCHEMA}")

    catalog = value.get("catalog")
    if not isinstance(catalog, dict) or catalog != {
        "id": CATALOG_ID,
        "version": CATALOG_VERSION,
    }:
        raise SurfaceContractError("surface catalog is not approved")

    surface_update = value.get("surfaceUpdate")
    if not isinstance(surface_update, dict):
        raise SurfaceContractError("surfaceUpdate must be an object")
    if set(surface_update) - {"surfaceId", "components"}:
        raise SurfaceContractError("surfaceUpdate contains unsupported properties")
    if "surfaceId" in surface_update:
        _require_identifier(surface_update["surfaceId"], "surfaceUpdate.surfaceId")

    components = surface_update.get("components")
    if not isinstance(components, list) or not 1 <= len(components) <= MAX_COMPONENTS:
        raise SurfaceContractError(f"surface must contain 1-{MAX_COMPONENTS} components")

    component_ids: set[str] = set()
    component_types: dict[str, str] = {}
    declared_children_by_id: Dict[str, list[str]] = {}
    declared_parent_by_id: Dict[str, str] = {}
    counter = [0]
    for index, component in enumerate(components):
        path = f"surfaceUpdate.components[{index}]"
        if not isinstance(component, dict):
            raise SurfaceContractError(f"{path} must be an object")
        if set(component) - {"id", "component", "parentId", "children"}:
            raise SurfaceContractError(f"{path} contains unsupported properties")
        component_id = _require_identifier(component.get("id"), f"{path}.id")
        if component_id in component_ids:
            raise SurfaceContractError(f"duplicate component id: {component_id}")
        component_ids.add(component_id)

        definition = component.get("component")
        if not isinstance(definition, dict) or len(definition) != 1:
            raise SurfaceContractError(f"{path}.component must contain exactly one type")
        component_type, props = next(iter(definition.items()))
        if component_type not in APPROVED_COMPONENT_TYPES:
            raise SurfaceContractError(f"component type is not approved: {component_type}")
        if not isinstance(props, dict):
            raise SurfaceContractError(f"{path}.component.{component_type} must be an object")
        props_path = f"{path}.component.{component_type}"
        _validate_bounded_value(props, props_path, 0, counter)
        _validate_component_props(component_type, props, props_path)
        component_types[component_id] = component_type

        if "parentId" in component:
            declared_parent_by_id[component_id] = _require_identifier(
                component["parentId"], f"{path}.parentId"
            )
        children = component.get("children", [])
        if not isinstance(children, list):
            raise SurfaceContractError(f"{path}.children must be an array")
        declared_children_by_id[component_id] = [
            _require_identifier(child, f"{path}.children") for child in children
        ]

    parent_by_child: Dict[str, str] = {}
    for child_id, parent_id in declared_parent_by_id.items():
        if parent_id not in component_ids:
            raise SurfaceContractError(f"unknown parent component: {parent_id}")
        if child_id == parent_id:
            raise SurfaceContractError("component cannot be its own parent")
        parent_by_child[child_id] = parent_id

    for component_id, child_ids in declared_children_by_id.items():
        if len(child_ids) != len(set(child_ids)):
            raise SurfaceContractError(f"component contains a duplicate child: {component_id}")
        for child_id in child_ids:
            if child_id not in component_ids:
                raise SurfaceContractError(f"unknown child component: {child_id}")
            if child_id == component_id:
                raise SurfaceContractError("component cannot be its own child")
            declared_parent = parent_by_child.get(child_id)
            if declared_parent is not None and declared_parent != component_id:
                raise SurfaceContractError(
                    f"component has conflicting parents: {child_id}"
                )
            parent_by_child[child_id] = component_id

    children_by_id: Dict[str, list[str]] = {
        component_id: [] for component_id in component_ids
    }
    for child_id, parent_id in parent_by_child.items():
        children_by_id[parent_id].append(child_id)
    _assert_acyclic(children_by_id)

    bindings = value.get("bindings")
    if not isinstance(bindings, list) or len(bindings) > MAX_BINDINGS:
        raise SurfaceContractError(f"surface may contain at most {MAX_BINDINGS} bindings")
    binding_ids: set[str] = set()
    for index, binding in enumerate(bindings):
        path = f"bindings[{index}]"
        if not isinstance(binding, dict) or set(binding) != {"id", "target", "source"}:
            raise SurfaceContractError(f"{path} must contain id, target, and source")
        binding_id = _require_identifier(binding["id"], f"{path}.id")
        if binding_id in binding_ids:
            raise SurfaceContractError(f"duplicate binding id: {binding_id}")
        binding_ids.add(binding_id)

        target = binding["target"]
        if not isinstance(target, dict) or set(target) != {"componentId", "prop"}:
            raise SurfaceContractError(f"{path}.target is invalid")
        target_component_id = target["componentId"]
        if target_component_id not in component_ids:
            raise SurfaceContractError(f"{path} targets an unknown component")
        target_prop = _require_identifier(target["prop"], f"{path}.target.prop")
        component_type = component_types[target_component_id]
        approved_targets = CATALOG_DECLARATION["components"][component_type]["bindingTargets"]
        if target_prop not in approved_targets:
            raise SurfaceContractError(
                f"{path}.target.prop is not approved for {component_type}: {target_prop}"
            )

        validate_binding_source(binding["source"], f"{path}.source", counter)

    return json.loads(encoded)

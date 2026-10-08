"""Ephemeral, fail-safe materialization of approved surface bindings."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Callable

from surface_contract import SurfaceContractError, validate_surface_spec


class SurfaceBindingError(ValueError):
    """Raised when a binding cannot be resolved within the approved projection."""


BindingFetcher = Callable[[str, dict[str, Any]], dict[str, Any]]


def _target_props(spec: dict, component_id: str) -> dict:
    for component in spec["surfaceUpdate"]["components"]:
        if component["id"] != component_id:
            continue
        return next(iter(component["component"].values()))
    raise SurfaceBindingError("binding target component is unavailable")


def _set_target(props: dict, path: str, value: Any) -> None:
    segments = path.split(".")
    current = props
    for segment in segments[:-1]:
        child = current.get(segment)
        if not isinstance(child, dict):
            raise SurfaceBindingError("binding target parent is unavailable")
        current = child
    current[segments[-1]] = copy.deepcopy(value)


def resolve_surface_bindings(
    spec: dict,
    fetcher: BindingFetcher,
    *,
    resolved_at: str | None = None,
) -> dict:
    """Resolve bindings into a detached view without mutating the definition."""
    definition = validate_surface_spec(spec)
    materialized = copy.deepcopy(definition)
    ledger: list[dict[str, Any]] = []
    timestamp = resolved_at or datetime.now(timezone.utc).isoformat()

    for binding in definition["bindings"]:
        entry: dict[str, Any] = {
            "binding_id": binding["id"],
            "target": copy.deepcopy(binding["target"]),
            "source_kind": binding["source"]["kind"],
            "resolved_at": timestamp,
        }
        try:
            result = fetcher(binding["source"]["kind"], copy.deepcopy(binding["source"]))
            if not isinstance(result, dict) or "value" not in result:
                raise SurfaceBindingError("binding source returned an invalid projection")
            candidate = copy.deepcopy(materialized)
            props = _target_props(candidate, binding["target"]["componentId"])
            _set_target(props, binding["target"]["prop"], result["value"])
            try:
                materialized = validate_surface_spec(candidate)
            except SurfaceContractError as error:
                raise SurfaceBindingError(f"resolved value is incompatible: {error}") from error
            entry.update({
                "status": "resolved",
                "source_ids": list(result.get("source_ids", []))[:2000],
                "source_revisions": list(result.get("source_revisions", []))[:2000],
                "freshness": result.get("freshness"),
            })
        except (SurfaceBindingError, ValueError) as error:
            entry.update({"status": "error", "error": str(error)[:1000]})
        ledger.append(entry)

    return {
        "definition": definition,
        "materialized_spec": materialized,
        "bindings": ledger,
        "resolved_at": timestamp,
    }

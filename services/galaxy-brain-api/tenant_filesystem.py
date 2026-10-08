"""Pure configuration helpers for tenant-bound filesystem datasources."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Mapping
from uuid import UUID


@dataclass(frozen=True)
class AuthorizedTenantRoot:
    configured_root: str
    connection_root: str
    relative_parts: tuple[str, ...]


def parse_tenant_filesystem_roots(raw: str) -> dict[str, tuple[str, ...]]:
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT must be a JSON object")

    result: dict[str, tuple[str, ...]] = {}
    for tenant_value, root_values in value.items():
        try:
            tenant_id = str(UUID(str(tenant_value)))
        except ValueError as error:
            raise ValueError("Filesystem datasource tenant keys must be UUIDs") from error
        if not isinstance(root_values, list):
            raise ValueError("Each filesystem datasource tenant must map to a list of roots")

        roots: list[str] = []
        for root_value in root_values:
            if not isinstance(root_value, str) or not root_value.strip():
                raise ValueError("Filesystem datasource roots must be non-empty strings")
            expanded = os.path.expanduser(root_value.strip())
            if not os.path.isabs(expanded):
                raise ValueError("Filesystem datasource roots must be absolute paths")
            root = os.path.realpath(expanded)
            if root == os.path.abspath(os.sep):
                raise ValueError("The filesystem root directory may not be allowed")
            if root not in roots:
                roots.append(root)
        result[tenant_id] = tuple(roots)
    return result


def roots_for_tenant(
    roots_by_tenant: Mapping[str, tuple[str, ...]],
    tenant_value: str,
) -> tuple[str, ...]:
    try:
        tenant_id = str(UUID(tenant_value))
    except ValueError:
        return ()
    return roots_by_tenant.get(tenant_id, ())


def path_is_within(candidate: str, root: str) -> bool:
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False


def authorize_tenant_root(
    roots_by_tenant: Mapping[str, tuple[str, ...]],
    tenant_value: str,
    root_value: str,
) -> str:
    return authorize_tenant_root_binding(
        roots_by_tenant,
        tenant_value,
        root_value,
    ).connection_root


def authorize_tenant_root_binding(
    roots_by_tenant: Mapping[str, tuple[str, ...]],
    tenant_value: str,
    root_value: str,
) -> AuthorizedTenantRoot:
    allowed_roots = roots_for_tenant(roots_by_tenant, tenant_value)
    if not allowed_roots:
        raise PermissionError("Filesystem datasources are disabled for this tenant.")
    root = os.path.realpath(os.path.expanduser(root_value))
    matches = [allowed_root for allowed_root in allowed_roots if path_is_within(root, allowed_root)]
    if not matches:
        raise PermissionError("Datasource root_path is outside this tenant's allowed roots")
    # Prefer the narrowest configured authority when roots overlap. The reader
    # receives this exact anchor; it must not rediscover authority from paths.
    configured_root = max(matches, key=lambda value: len(os.path.normpath(value)))
    relative = os.path.relpath(root, configured_root)
    relative_parts = () if relative == os.curdir else tuple(relative.split(os.sep))
    if any(part in {"", ".", ".."} for part in relative_parts):
        raise PermissionError("Datasource root_path cannot be anchored safely")
    return AuthorizedTenantRoot(
        configured_root=configured_root,
        connection_root=root,
        relative_parts=relative_parts,
    )

import json
import unittest

from graph_window import (
    CLUSTER_SPECS,
    GraphWindowError,
    cluster_for_id,
    cluster_id,
    decode_cursor,
    encode_cursor,
    parse_request,
)


TENANT = "30000000-0000-4000-8000-000000000001"
PRINCIPAL = "40000000-0000-4000-8000-000000000001"
SECRET = "test-graph-window-signing-secret"


def payload(**updates):
    value = {
        "schemaId": "gb.graph-window-request.v1",
        "workspaceId": "tenant-catalog",
        "mode": "mixed",
        "lens": "explore",
        "scale": "corpus",
        "viewport": None,
        "filters": {"kinds": [], "relations": []},
        "rootRef": None,
        "expandClusterId": None,
        "cursor": None,
    }
    value.update(updates)
    return value


class GraphWindowContractTests(unittest.TestCase):
    def test_request_is_strict_and_canonical(self):
        result = parse_request(json.dumps(payload()).encode())
        self.assertEqual(result["workspaceId"], "tenant-catalog")
        self.assertEqual(result["filters"], {"kinds": [], "relations": []})

        for invalid in (
            {**payload(), "unexpected": True},
            payload(scale="project"),
            payload(lens="verify"),
            payload(workspaceId="another-workspace"),
            payload(filters={"kinds": ["document", "document"], "relations": []}),
            payload(filters={"kinds": ["ham.task"], "relations": []}),
            payload(cursor="abc"),
        ):
            with self.assertRaises(GraphWindowError):
                parse_request(json.dumps(invalid).encode())

    def test_request_rejects_duplicate_json_fields_and_oversize(self):
        duplicate = b'{"schemaId":"gb.graph-window-request.v1","schemaId":"other"}'
        with self.assertRaises(GraphWindowError):
            parse_request(duplicate)
        with self.assertRaises(GraphWindowError) as error:
            parse_request(b"{" + b"x" * 40_000 + b"}")
        self.assertEqual(error.exception.status_code, 413)

    def test_cluster_ids_are_stable_and_do_not_depend_on_counts(self):
        identifiers = [cluster_id(spec, TENANT) for spec in CLUSTER_SPECS]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        self.assertTrue(all(value.startswith("gwc:") for value in identifiers))
        for spec, value in zip(CLUSTER_SPECS, identifiers):
            self.assertEqual(cluster_for_id(value, tenant_id=TENANT, workspace_id="tenant-catalog"), spec)
        self.assertNotEqual(
            cluster_id(CLUSTER_SPECS[0], TENANT),
            cluster_id(CLUSTER_SPECS[0], "30000000-0000-4000-8000-000000000002"),
        )

    def test_cursor_is_query_principal_and_tenant_bound(self):
        request = parse_request(json.dumps(payload(
            expandClusterId=cluster_id(CLUSTER_SPECS[0], TENANT),
        )).encode())
        cursor = encode_cursor(
            secret=SECRET,
            tenant_id=TENANT,
            principal_id=PRINCIPAL,
            request=request,
            updated_at="2026-09-25T12:00:00+00:00",
            member_id="50000000-0000-4000-8000-000000000001",
            now=1_000,
        )
        reparsed = parse_request(json.dumps({**request, "cursor": cursor}).encode())
        self.assertEqual(reparsed["cursor"], cursor)
        decoded = decode_cursor(
            cursor,
            secret=SECRET,
            tenant_id=TENANT,
            principal_id=PRINCIPAL,
            request=request,
            now=1_001,
        )
        self.assertEqual(decoded["memberId"], "50000000-0000-4000-8000-000000000001")
        for changes in (
            {"tenant_id": "30000000-0000-4000-8000-000000000002"},
            {"principal_id": "40000000-0000-4000-8000-000000000002"},
            {"request": {**request, "mode": "citation"}},
            {"secret": "wrong-secret"},
        ):
            arguments = {
                "secret": SECRET,
                "tenant_id": TENANT,
                "principal_id": PRINCIPAL,
                "request": request,
                "now": 1_001,
                **changes,
            }
            with self.assertRaises(GraphWindowError):
                decode_cursor(cursor, **arguments)

    def test_cursor_expires_without_becoming_a_different_page(self):
        request = parse_request(json.dumps(payload(
            expandClusterId=cluster_id(CLUSTER_SPECS[1], TENANT),
        )).encode())
        cursor = encode_cursor(
            secret=SECRET, tenant_id=TENANT, principal_id=PRINCIPAL,
            request=request, updated_at="2026-09-25T12:00:00+00:00",
            member_id="50000000-0000-4000-8000-000000000001", now=1_000,
        )
        with self.assertRaises(GraphWindowError) as error:
            decode_cursor(
                cursor, secret=SECRET, tenant_id=TENANT, principal_id=PRINCIPAL,
                request=request, now=2_000,
            )
        self.assertEqual(error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()

import os
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import datasource_filesystem
from durable_ingestion import IngestionContractError, decode_import_metadata
from datasource_filesystem import (
    DatasourceFileRejected,
    datasource_media_type,
    enumerate_authorized_datasource_files,
    read_authorized_datasource_file,
)
from tenant_filesystem import AuthorizedTenantRoot


class AuthorizedDatasourceReadTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.configured_root = Path(self.temporary_directory.name) / "authorized"
        self.root = self.configured_root / "vault"
        self.outside = Path(self.temporary_directory.name) / "outside"
        self.root.mkdir(parents=True)
        self.outside.mkdir()
        self.binding = AuthorizedTenantRoot(
            configured_root=str(self.configured_root),
            connection_root=str(self.root),
            relative_parts=("vault",),
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_known_text_formats_use_canonical_media_and_same_handle_bytes(self):
        expected = {
            "notes.ts": "text/plain",
            "measurements.csv": "text/csv",
            "run.sh": "text/x-shellscript",
            "Model.java": "text/plain",
            "paper.md": "text/markdown",
        }
        for filename, media_type in expected.items():
            with self.subTest(filename=filename):
                content = f"safe content for {filename}".encode("utf-8")
                (self.root / filename).write_bytes(content)
                exact = read_authorized_datasource_file(self.binding, filename, 10_000)
                self.assertEqual(exact.content, content)
                self.assertEqual(exact.media_type, media_type)

    def test_bounded_enumeration_preserves_stable_ids_and_skip_rules(self):
        (self.root / "zeta.md").write_text("z", encoding="utf-8")
        nested = self.root / "papers"
        nested.mkdir()
        (nested / "alpha.pdf").write_bytes(b"%PDF-1.7\n")
        (self.root / ".secret.md").write_text("hidden", encoding="utf-8")
        skipped = self.root / "node_modules"
        skipped.mkdir()
        (skipped / "package.md").write_text("skip", encoding="utf-8")

        listing = enumerate_authorized_datasource_files(self.binding)
        self.assertEqual(
            [entry.item_id for entry in listing.entries],
            ["papers/alpha.pdf", "zeta.md"],
        )
        self.assertFalse(listing.truncated)
        capped = enumerate_authorized_datasource_files(self.binding, maximum_items=1)
        self.assertEqual(len(capped.entries), 1)
        self.assertTrue(capped.truncated)

    def test_binary_masquerading_as_text_is_rejected(self):
        (self.root / "payload.ts").write_bytes(b"\xff\xfe\x00binary")
        with self.assertRaises(DatasourceFileRejected):
            read_authorized_datasource_file(self.binding, "payload.ts", 10_000)

    def test_svg_is_not_classified_as_durable_text(self):
        self.assertEqual(datasource_media_type("figure.svg"), "image/svg+xml")
        (self.root / "figure.svg").write_text("<svg></svg>", encoding="utf-8")
        with self.assertRaises(DatasourceFileRejected):
            read_authorized_datasource_file(self.binding, "figure.svg", 10_000)

    def test_datasource_provenance_has_one_bounded_durable_wire_shape(self):
        connection_id = "10000000-0000-4000-8000-000000000001"
        source_uri = f"datasource://{connection_id}/notes%2Fresult.md"
        metadata = {
            "title": "Result",
            "filename": "result.md",
            "sourceKind": "datasource",
            "sourceUri": source_uri,
            "arxivId": None,
        }
        encoded = base64.urlsafe_b64encode(
            json.dumps(metadata, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        self.assertEqual(decode_import_metadata(encoded)["sourceUri"], source_uri)
        metadata["sourceKind"] = "upload"
        encoded = base64.urlsafe_b64encode(
            json.dumps(metadata, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        with self.assertRaises(IngestionContractError):
            decode_import_metadata(encoded)

        for invalid_uri in (
            f"datasource://user@{connection_id}/notes%2Fresult.md",
            f"datasource://{connection_id}:8443/notes%2Fresult.md",
        ):
            with self.subTest(source_uri=invalid_uri):
                metadata["sourceKind"] = "datasource"
                metadata["sourceUri"] = invalid_uri
                encoded = base64.urlsafe_b64encode(
                    json.dumps(metadata, separators=(",", ":")).encode("utf-8")
                ).decode("ascii").rstrip("=")
                with self.assertRaises(IngestionContractError):
                    decode_import_metadata(encoded)

    def test_final_symlink_is_rejected_when_the_platform_can_create_it(self):
        target = self.outside / "secret.txt"
        target.write_text("outside", encoding="utf-8")
        link = self.root / "linked.txt"
        try:
            link.symlink_to(target)
        except OSError as error:
            self.skipTest(f"Symlinks are unavailable on this host: {error}")
        with self.assertRaises(DatasourceFileRejected):
            read_authorized_datasource_file(self.binding, "linked.txt", 10_000)

    @unittest.skipUnless(os.name == "posix", "POSIX openat race regression")
    def test_parent_swap_to_symlink_is_rejected_at_open_boundary(self):
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "paper.txt").write_text("inside", encoding="utf-8")
        (self.outside / "paper.txt").write_text("outside", encoding="utf-8")
        original_open = os.open
        swapped = False

        def racing_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == "nested" and kwargs.get("dir_fd") is not None and not swapped:
                swapped = True
                nested.rename(self.root / "nested-held")
                nested.symlink_to(self.outside, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(datasource_filesystem.os, "open", side_effect=racing_open):
            with self.assertRaises(datasource_filesystem.DatasourceFileNotFound):
                read_authorized_datasource_file(self.binding, "nested/paper.txt", 10_000)

    @unittest.skipUnless(os.name == "posix", "POSIX configured-root anchor regression")
    def test_connection_root_ancestor_swap_to_symlink_is_rejected(self):
        group = self.configured_root / "group"
        connection_root = group / "vault"
        connection_root.mkdir(parents=True)
        (connection_root / "paper.txt").write_text("inside", encoding="utf-8")
        outside_group = self.outside / "group"
        outside_vault = outside_group / "vault"
        outside_vault.mkdir(parents=True)
        (outside_vault / "paper.txt").write_text("outside", encoding="utf-8")
        binding = AuthorizedTenantRoot(
            configured_root=str(self.configured_root),
            connection_root=str(connection_root),
            relative_parts=("group", "vault"),
        )
        original_open = os.open
        swapped = False

        def racing_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == "group" and kwargs.get("dir_fd") is not None and not swapped:
                swapped = True
                group.rename(self.configured_root / "group-held")
                group.symlink_to(outside_group, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(datasource_filesystem.os, "open", side_effect=racing_open):
            with self.assertRaises(datasource_filesystem.DatasourceFileNotFound):
                read_authorized_datasource_file(binding, "paper.txt", 10_000)

    @unittest.skipUnless(os.name == "posix", "POSIX enumeration anchor regression")
    def test_enumeration_rejects_connection_root_ancestor_swap(self):
        group = self.configured_root / "enumeration-group"
        connection_root = group / "vault"
        connection_root.mkdir(parents=True)
        (connection_root / "paper.txt").write_text("inside", encoding="utf-8")
        outside_group = self.outside / "enumeration-group"
        outside_vault = outside_group / "vault"
        outside_vault.mkdir(parents=True)
        (outside_vault / "paper.txt").write_text("outside", encoding="utf-8")
        binding = AuthorizedTenantRoot(
            configured_root=str(self.configured_root),
            connection_root=str(connection_root),
            relative_parts=("enumeration-group", "vault"),
        )
        original_open = os.open
        swapped = False

        def racing_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == "enumeration-group" and kwargs.get("dir_fd") is not None and not swapped:
                swapped = True
                group.rename(self.configured_root / "enumeration-group-held")
                group.symlink_to(outside_group, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(datasource_filesystem.os, "open", side_effect=racing_open):
            with self.assertRaises(datasource_filesystem.DatasourceFileNotFound):
                enumerate_authorized_datasource_files(binding)

    @unittest.skipUnless(os.name == "nt", "Windows held-handle containment regression")
    def test_windows_rejects_opened_handle_outside_held_root(self):
        item = self.root / "paper.txt"
        item.write_text("inside", encoding="utf-8")
        held_configured = os.path.normcase(os.path.normpath(str(self.configured_root)))
        held_connection = os.path.normcase(os.path.normpath(str(self.root)))
        escaped = os.path.normcase(os.path.normpath(str(self.outside / "paper.txt")))
        with mock.patch.object(
            datasource_filesystem,
            "_windows_final_path",
            side_effect=[held_configured, held_connection, held_connection, escaped],
        ):
            with self.assertRaises(DatasourceFileRejected):
                read_authorized_datasource_file(self.binding, "paper.txt", 10_000)

    @unittest.skipUnless(os.name == "nt", "Windows root-identity regression")
    def test_windows_rejects_root_identity_change_after_item_open(self):
        item = self.root / "paper.txt"
        item.write_text("inside", encoding="utf-8")
        with mock.patch.object(
            datasource_filesystem,
            "_windows_file_identity",
            side_effect=[(1, b"configured"), (2, b"connection"), (3, b"replacement")],
        ):
            with self.assertRaises(DatasourceFileRejected):
                read_authorized_datasource_file(self.binding, "paper.txt", 10_000)

    @unittest.skipUnless(os.name == "nt", "Windows configured-root anchor regression")
    def test_windows_rejects_connection_root_ancestor_escape(self):
        group = self.configured_root / "group"
        connection_root = group / "vault"
        connection_root.mkdir(parents=True)
        (connection_root / "paper.txt").write_text("inside", encoding="utf-8")
        binding = AuthorizedTenantRoot(
            configured_root=str(self.configured_root),
            connection_root=str(connection_root),
            relative_parts=("group", "vault"),
        )
        held_configured = os.path.normcase(os.path.normpath(str(self.configured_root)))
        escaped = os.path.normcase(os.path.normpath(str(self.outside / "group")))
        with mock.patch.object(
            datasource_filesystem,
            "_windows_final_path",
            side_effect=[held_configured, escaped],
        ):
            with self.assertRaises(DatasourceFileRejected):
                read_authorized_datasource_file(binding, "paper.txt", 10_000)

    @unittest.skipUnless(os.name == "nt", "Windows enumeration anchor regression")
    def test_windows_enumeration_rejects_connection_root_ancestor_escape(self):
        group = self.configured_root / "enumeration-group"
        connection_root = group / "vault"
        connection_root.mkdir(parents=True)
        (connection_root / "paper.txt").write_text("inside", encoding="utf-8")
        binding = AuthorizedTenantRoot(
            configured_root=str(self.configured_root),
            connection_root=str(connection_root),
            relative_parts=("enumeration-group", "vault"),
        )
        held_configured = os.path.normcase(os.path.normpath(str(self.configured_root)))
        escaped = os.path.normcase(os.path.normpath(str(self.outside / "enumeration-group")))
        with mock.patch.object(
            datasource_filesystem,
            "_windows_final_path",
            side_effect=[held_configured, held_configured, escaped],
        ):
            with self.assertRaises(DatasourceFileRejected):
                enumerate_authorized_datasource_files(binding)


if __name__ == "__main__":
    unittest.main()

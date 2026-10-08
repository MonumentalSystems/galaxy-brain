import base64
import hashlib
import json
import struct
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from durable_ingestion import (
    IngestionContractError,
    audio_original_manifest,
    inspect_webm_opus_audio,
    normalize_audio_original_manifest,
)
from server import IdentityContext, import_document
from test_document_import import ImportCursor, request, PRINCIPAL_ID, TENANT_ID


def _concat(*parts):
    return b"".join(parts)


def _size(value):
    for length in range(1, 9):
        if value < (1 << (7 * length)) - 1:
            encoded = bytearray(value.to_bytes(length, "big"))
            encoded[0] |= 1 << (8 - length)
            return bytes(encoded)
    raise ValueError("fixture too large")


def _element(element_id, payload):
    return element_id + _size(len(payload)) + payload


def _uint(element_id, value):
    length = max(1, (value.bit_length() + 7) // 8)
    return _element(element_id, value.to_bytes(length, "big"))


def webm_opus_fixture(*, track_type=2, codec=b"A_OPUS", cluster=True, lacing=False,
                       duplicate=False, opus_packet=b"\xf8\xff"):
    opus = bytearray(19)
    opus[:8] = b"OpusHead"
    opus[8] = 1
    opus[9] = 1
    opus[10:12] = (312).to_bytes(2, "little")
    opus[12:16] = (48_000).to_bytes(4, "little")
    frequency = struct.pack(">d", 48_000)
    audio = _element(b"\xe1", _element(b"\xb5", frequency) + _uint(b"\x9f", 1))
    entry = _element(b"\xae", _concat(
        _uint(b"\xd7", 1), _uint(b"\x73\xc5", 1), _uint(b"\x83", track_type),
        _uint(b"\x9c", 0), _element(b"\x86", codec), _element(b"\x63\xa2", bytes(opus)),
        _uint(b"\x56\xaa", 6_500_000), _uint(b"\x56\xbb", 80_000_000), audio,
    ))
    tracks = _element(b"\x16\x54\xae\x6b", entry + (entry if duplicate else b""))
    info = _element(b"\x15\x49\xa9\x66", _concat(
        _uint(b"\x2a\xd7\xb1", 1_000_000),
        _element(b"\x4d\x80", b"Galaxy"), _element(b"\x57\x41", b"Galaxy"),
    ))
    block = _element(b"\xa3", bytes([0x81, 0, 0, 0x82 if lacing else 0x80]) + opus_packet)
    cluster_value = _element(b"\x1f\x43\xb6\x75", _uint(b"\xe7", 0) + block) if cluster else b""
    segment = _element(b"\x18\x53\x80\x67", info + tracks + cluster_value)
    header = _element(b"\x1a\x45\xdf\xa3", _concat(
        _uint(b"\x42\x86", 1), _uint(b"\x42\xf7", 1), _uint(b"\x42\xf2", 4),
        _uint(b"\x42\xf3", 8), _element(b"\x42\x82", b"webm"),
        _uint(b"\x42\x87", 4), _uint(b"\x42\x85", 2),
    ))
    return header + segment


class AudioOriginalContractTests(unittest.TestCase):
    def test_valid_audio_profile_produces_bound_manifest(self):
        content = webm_opus_fixture()
        digest = hashlib.sha256(content).hexdigest()
        self.assertEqual(inspect_webm_opus_audio(content), {"trackCount": 1, "channels": 1})
        manifest = audio_original_manifest(content, "capture.webm", "audio/webm")
        self.assertEqual(manifest["contentSha256"], digest)
        self.assertEqual(normalize_audio_original_manifest(
            manifest, media_type="audio/webm", content_sha256=digest, byte_size=len(content),
        ), manifest)

    def test_invalid_structure_and_mismatches_are_rejected(self):
        valid = webm_opus_fixture()
        invalid = [
            webm_opus_fixture(track_type=1), webm_opus_fixture(codec=b"A_VORBIS"),
            webm_opus_fixture(cluster=False), webm_opus_fixture(lacing=True),
            webm_opus_fixture(duplicate=True), valid[:-1], valid + b"\x00",
        ]
        for content in invalid:
            with self.subTest(length=len(content)), self.assertRaises(IngestionContractError):
                inspect_webm_opus_audio(content)
        with self.assertRaises(IngestionContractError):
            audio_original_manifest(valid, "capture.weba", "audio/webm")
        with self.assertRaises(IngestionContractError):
            audio_original_manifest(valid, "capture.webm", "video/webm")

    def test_opus_packet_framing_matches_shared_rfc_6716_vectors(self):
        vectors_path = Path(__file__).parents[2] / "scripts" / "fixtures" / "opus-packet-vectors.json"
        vectors = json.loads(vectors_path.read_text(encoding="utf-8"))
        for vector in vectors:
            packet = bytes(vector["prefix"]) + bytes([vector.get("fillByte", 0)]) * vector.get("fillCount", 0)
            with self.subTest(name=vector["name"]):
                if vector["valid"]:
                    self.assertEqual(
                        inspect_webm_opus_audio(webm_opus_fixture(opus_packet=packet)),
                        {"trackCount": 1, "channels": 1},
                    )
                else:
                    with self.assertRaises(IngestionContractError):
                            inspect_webm_opus_audio(webm_opus_fixture(opus_packet=packet))

    def test_installed_browser_mediarecorder_unknown_size_clusters(self):
        fixtures_path = Path(__file__).parents[2] / "scripts" / "fixtures" / "browser-mediarecorder-webm.json"
        fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))
        for fixture in fixtures:
            content = base64.b64decode(fixture["base64"], validate=True)
            with self.subTest(browser=fixture["browser"]):
                self.assertEqual(len(content), fixture["byteSize"])
                self.assertEqual(inspect_webm_opus_audio(content), {"trackCount": 1, "channels": 1})
                with self.assertRaises(IngestionContractError):
                    inspect_webm_opus_audio(content[:-1])
                with self.assertRaises(IngestionContractError):
                    inspect_webm_opus_audio(content + b"\x00")

    def test_unknown_size_cluster_delimiter_shares_element_budget(self):
        fixtures_path = Path(__file__).parents[2] / "scripts" / "fixtures" / "browser-mediarecorder-webm.json"
        fixture = json.loads(fixtures_path.read_text(encoding="utf-8"))[0]
        content = base64.b64decode(fixture["base64"], validate=True)
        marker = b"\x1f\x43\xb6\x75\x01\xff\xff\xff\xff\xff\xff\xff"
        insertion = content.index(marker) + len(marker)
        near_boundary = content[:insertion] + (b"\xec\x80" * 50_000) + content[insertion:]
        self.assertEqual(
            inspect_webm_opus_audio(near_boundary),
            {"trackCount": 1, "channels": 1},
        )
        padded = content[:insertion] + (b"\xec\x80" * 100_001) + content[insertion:]
        with self.assertRaisesRegex(IngestionContractError, "too many elements"):
            inspect_webm_opus_audio(padded)


class AudioOriginalImportTests(unittest.IsolatedAsyncioTestCase):
    async def test_backend_revalidates_and_persists_manifest_on_existing_document_spine(self):
        content = webm_opus_fixture()
        cursor = ImportCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=object()), patch("server._transaction", transaction):
            await import_document(request(
                content, filename="capture.webm", media_type="audio/webm",
            ), identity)
        source = next(parameters for sql, parameters in cursor.executions
                      if sql.startswith("INSERT INTO gb_artifact_sources"))
        manifest = source[5].adapted["audioOriginal"]
        self.assertEqual(manifest["schemaId"], "gb.audio-original.v1")
        self.assertEqual(manifest["contentSha256"], hashlib.sha256(content).hexdigest())
        artifact = next(parameters for sql, parameters in cursor.executions
                        if sql.startswith("INSERT INTO gb_artifacts"))
        self.assertEqual(artifact[4].adapted, content)
        self.assertEqual(artifact[3], "audio/webm")


if __name__ == "__main__":
    unittest.main()

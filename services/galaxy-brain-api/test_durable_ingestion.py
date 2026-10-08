import unittest
import base64
import json
import hashlib
import io
import struct
import zipfile
from pathlib import Path
from unittest.mock import patch

from durable_ingestion import (
    IngestionContractError,
    DOCX_MEDIA_TYPE,
    MAX_IMPORT_METADATA_BYTES,
    decode_import_metadata,
    normalize_arxiv_id,
    normalize_display_filename,
    normalize_docling_document,
    normalize_docling_markdown,
    normalize_markitdown_document,
    normalize_plain_text_document,
    normalize_source_uri,
    fallback_plugin_for_filename,
    representation_content_sha256,
    transform_request_hash,
    validate_docx_package,
)

DOCX_CONTENT_TYPES = b'''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
DOCX_RELATIONSHIPS = b'''<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
DOCX_DOCUMENT = b'''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'''


def docx_fixture(extra=None, omit=None):
    parts = {
        "[Content_Types].xml": DOCX_CONTENT_TYPES,
        "_rels/.rels": DOCX_RELATIONSHIPS,
        "word/document.xml": DOCX_DOCUMENT,
    }
    parts.update(extra or {})
    for name in omit or ():
        parts.pop(name, None)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)
    return output.getvalue()


class DurableIngestionContractTests(unittest.TestCase):
    def test_strict_docx_package_accepts_only_canonical_non_macro_ooxml(self):
        content = docx_fixture()
        self.assertEqual(validate_docx_package(content, "paper.docx", None), DOCX_MEDIA_TYPE)
        self.assertEqual(validate_docx_package(content, "paper.docx", DOCX_MEDIA_TYPE), DOCX_MEDIA_TYPE)
        invalid = (
            (content, "paper.zip", DOCX_MEDIA_TYPE),
            (content, "paper.docx", "application/zip"),
            (docx_fixture(omit={"word/document.xml"}), "paper.docx", DOCX_MEDIA_TYPE),
            (docx_fixture(extra={"word/vbaProject.bin": b"macro"}), "paper.docx", DOCX_MEDIA_TYPE),
            (docx_fixture(extra={"../escape.xml": b"escape"}), "paper.docx", DOCX_MEDIA_TYPE),
            (docx_fixture(extra={"word/embeddings/object1.bin": b"ole"}), "paper.docx", DOCX_MEDIA_TYPE),
        )
        for body, filename, media_type in invalid:
            with self.subTest(filename=filename, media_type=media_type, size=len(body)):
                with self.assertRaises(IngestionContractError):
                    validate_docx_package(body, filename, media_type)

    def test_docx_package_binds_raw_names_and_strict_ooxml_semantics(self):
        placeholder = "word/document.xmlXevil"
        nul_name = docx_fixture(extra={placeholder: DOCX_DOCUMENT}, omit={"word/document.xml"}).replace(
            placeholder.encode("ascii"), b"word/document.xml\0evil",
        )
        forged_root = b'''<x:Relationships xmlns:x="urn:forged" xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></x:Relationships>'''
        forged_type = DOCX_RELATIONSHIPS.replace(
            b"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
            b"https://example.invalid/officeDocument",
        )
        duplicate_override = DOCX_CONTENT_TYPES.replace(
            b"</Types>",
            b'''<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>''',
        )
        active_type = DOCX_CONTENT_TYPES.replace(
            b"</Types>",
            b'''<Override PartName="/word/renamed.xml" ContentType="application/vnd.ms-office.activeX+xml"/></Types>''',
        )
        utf16_entity = '''<?xml version="1.0" encoding="utf-16"?><!DOCTYPE document [<!ENTITY x "boom">]><document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;</document>'''.encode("utf-16")
        for body in (
            nul_name,
            docx_fixture(extra={"word/payload.bin": b"ACTIVE"}),
            docx_fixture(extra={"word/media/payload.js": b"ACTIVE"}),
            docx_fixture(extra={"word/renamed.xml": b"<renamed/>"}),
            docx_fixture(extra={"_rels/.rels": forged_root}),
            docx_fixture(extra={"_rels/.rels": forged_type}),
            docx_fixture(extra={"[Content_Types].xml": duplicate_override}),
            docx_fixture(extra={"[Content_Types].xml": active_type, "word/renamed.xml": b"inactive name"}),
            docx_fixture(extra={"word/document.xml": utf16_entity}),
        ):
            with self.subTest(size=len(body)), self.assertRaises(IngestionContractError):
                validate_docx_package(body, "paper.docx", DOCX_MEDIA_TYPE)

        printer_types = DOCX_CONTENT_TYPES.replace(
            b"</Types>",
            b'''<Override PartName="/word/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.printerSettings"/></Types>''',
        )
        printer = docx_fixture(extra={
            "[Content_Types].xml": printer_types,
            "word/printerSettings/printerSettings1.bin": b"printer settings",
        })
        self.assertEqual(validate_docx_package(printer, "paper.docx", DOCX_MEDIA_TYPE), DOCX_MEDIA_TYPE)

    def test_docx_package_rejects_bombs_duplicates_encryption_and_symlinks(self):
        bomb = docx_fixture(extra={"word/huge.xml": b"A" * (2 * 1024 * 1024)})
        with self.assertRaisesRegex(IngestionContractError, "compression ratio"):
            validate_docx_package(bomb, "paper.docx", DOCX_MEDIA_TYPE)

        def special(info):
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                base = docx_fixture()
                with zipfile.ZipFile(io.BytesIO(base), "r") as source:
                    for entry in source.infolist():
                        archive.writestr(entry.filename, source.read(entry))
                archive.writestr(info, b"unsafe")
            return output.getvalue()

        symlink = zipfile.ZipInfo("word/link.xml")
        symlink.create_system = 3
        symlink.external_attr = 0o120777 << 16
        with self.assertRaisesRegex(IngestionContractError, "filesystem"):
            validate_docx_package(special(symlink), "paper.docx", DOCX_MEDIA_TYPE)

        encrypted = bytearray(docx_fixture())
        local = encrypted.find(b"PK\x03\x04")
        central = encrypted.find(b"PK\x01\x02")
        struct.pack_into("<H", encrypted, local + 6, struct.unpack_from("<H", encrypted, local + 6)[0] | 1)
        struct.pack_into("<H", encrypted, central + 8, struct.unpack_from("<H", encrypted, central + 8)[0] | 1)
        with self.assertRaises(IngestionContractError):
            validate_docx_package(bytes(encrypted), "paper.docx", DOCX_MEDIA_TYPE)

        duplicate = io.BytesIO()
        with zipfile.ZipFile(duplicate, "w") as archive:
            for name, value in {
                "[Content_Types].xml": b"x" * 20,
                "_rels/.rels": b"x" * 20,
                "word/document.xml": b"x" * 20,
            }.items():
                archive.writestr(name, value)
            with self.assertWarns(UserWarning):
                archive.writestr("word/document.xml", b"duplicate")
        with self.assertRaisesRegex(IngestionContractError, "part names"):
            validate_docx_package(duplicate.getvalue(), "paper.docx", DOCX_MEDIA_TYPE)

        mismatched = bytearray(docx_fixture())
        local = mismatched.find(b"PK\x03\x04")
        struct.pack_into("<H", mismatched, local + 8, zipfile.ZIP_STORED)
        with self.assertRaisesRegex(IngestionContractError, "local ZIP header"):
            validate_docx_package(bytes(mismatched), "paper.docx", DOCX_MEDIA_TYPE)

        prefixed = bytearray(docx_fixture())
        eocd = len(prefixed) - 22
        central_offset = struct.unpack_from("<I", prefixed, eocd + 16)[0]
        entry_count = struct.unpack_from("<H", prefixed, eocd + 10)[0]
        cursor = central_offset
        for _index in range(entry_count):
            local_offset = struct.unpack_from("<I", prefixed, cursor + 42)[0]
            struct.pack_into("<I", prefixed, cursor + 42, local_offset + 64)
            name_length, extra_length, comment_length = struct.unpack_from("<HHH", prefixed, cursor + 28)
            cursor += 46 + name_length + extra_length + comment_length
        struct.pack_into("<I", prefixed, eocd + 16, central_offset + 64)
        with self.assertRaisesRegex(IngestionContractError, "opaque"):
            validate_docx_package(b"MZ" + bytes(62) + bytes(prefixed), "paper.docx", DOCX_MEDIA_TYPE)

        body = bytearray(docx_fixture())
        eocd = len(body) - 22
        central_offset = struct.unpack_from("<I", body, eocd + 16)[0]
        gap = b"opaque"
        gapped = bytearray(body[:central_offset] + gap + body[central_offset:])
        struct.pack_into("<I", gapped, eocd + len(gap) + 16, central_offset + len(gap))
        with self.assertRaisesRegex(IngestionContractError, "opaque"):
            validate_docx_package(bytes(gapped), "paper.docx", DOCX_MEDIA_TYPE)

    def test_import_metadata_round_trips_unicode_through_ascii_header(self):
        metadata = {
            'title': 'β winding field', 'filename': 'δοκιμή.pdf', 'sourceKind': 'upload',
            'sourceUri': None, 'arxivId': None,
        }
        header = base64.urlsafe_b64encode(
            json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        ).decode('ascii').rstrip('=')
        self.assertTrue(header.isascii())
        self.assertEqual(decode_import_metadata(header), metadata)

    def test_web_capture_intent_digest_round_trips_only_for_url_sources(self):
        digest = 'c' * 64
        metadata = {
            'title': 'Captured theorem', 'filename': 'captured-theorem.md',
            'sourceKind': 'url', 'sourceUri': 'https://example.org/theorem',
            'arxivId': None, 'captureIntentSha256': digest,
        }
        header = base64.urlsafe_b64encode(
            json.dumps(metadata, separators=(',', ':')).encode('utf-8')
        ).decode('ascii').rstrip('=')
        self.assertEqual(decode_import_metadata(header), metadata)

        for invalid in (
            {**metadata, 'sourceKind': 'upload', 'sourceUri': None},
            {**metadata, 'captureIntentSha256': 'C' * 64},
        ):
            invalid_header = base64.urlsafe_b64encode(
                json.dumps(invalid, separators=(',', ':')).encode('utf-8')
            ).decode('ascii').rstrip('=')
            with self.subTest(invalid=invalid), self.assertRaises(IngestionContractError):
                decode_import_metadata(invalid_header)

    def test_import_metadata_rejects_invalid_and_oversized_values(self):
        with self.assertRaises(IngestionContractError):
            decode_import_metadata('not+base64url')
        oversized = base64.urlsafe_b64encode(b'x' * (MAX_IMPORT_METADATA_BYTES + 1)).decode('ascii').rstrip('=')
        with self.assertRaises(IngestionContractError):
            decode_import_metadata(oversized)

    def test_filename_is_stable_and_retains_arxiv_version(self):
        name = normalize_display_filename(
            'A / Difficult: Paper?', '2404.06147v2.pdf', 'a' * 64, '2404.06147v2'
        )
        self.assertEqual(name, 'A Difficult Paper [arXiv 2404.06147v2].pdf')
        self.assertEqual(normalize_arxiv_id('https://arxiv.org/pdf/2404.06147v2.pdf'), '2404.06147v2')

    def test_non_arxiv_name_uses_content_identity(self):
        self.assertEqual(
            normalize_display_filename('Notes', 'random-string.md', 'b' * 64),
            'Notes [bbbbbbbbbbbb].md',
        )

    def test_source_uri_is_http_only_and_rejects_embedded_credentials(self):
        self.assertEqual(normalize_source_uri('HTTPS://example.org/paper?q=1'), 'https://example.org/paper?q=1')
        with self.assertRaises(IngestionContractError):
            normalize_source_uri('javascript:alert(1)')
        with self.assertRaises(IngestionContractError):
            normalize_source_uri('https://user:secret@example.org/paper')

    def test_docling_normalization_preserves_latex_and_page_region(self):
        value = normalize_docling_document({
            'status': 'success',
            'document': {'pages': [{'number': 1}], 'blocks': [{
                'id': 'eq-1', 'kind': 'formula', 'latex': r'E=mc^2',
                'page': 1, 'region': {'x': 1, 'y': 2, 'width': 3, 'height': 4},
            }]}
        })
        self.assertEqual(value['schemaId'], 'gb.document-structure.v1')
        self.assertEqual(value['blocks'][0]['latex'], r'E=mc^2')
        self.assertEqual(value['readingOrder'], ['eq-1'])

    def test_docling_rejects_unbounded_or_contentless_blocks(self):
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'success', 'document': {'blocks': [{'kind': 'text'}]}})

    def test_official_docling_response_preserves_order_pages_regions_formula_and_markdown(self):
        payload = {
            'status': 'success',
            'document': {
                'md_content': '# Paper\n\n$$E=mc^2$$',
                'json_content': {
                    'pages': {'1': {'page_no': 1, 'size': {'width': 612, 'height': 792}}},
                    'texts': [
                        {'self_ref': '#/texts/0', 'label': 'text', 'text': 'Introduction',
                         'prov': [{'page_no': 1, 'bbox': {
                             'l': 10, 't': 20, 'r': 100, 'b': 40, 'coord_origin': 'TOPLEFT',
                         }}]},
                        {'self_ref': '#/texts/1', 'label': 'formula', 'text': r'E=mc^2',
                         'prov': [{'page_no': 1, 'bbox': {
                             'l': 10, 't': 50, 'r': 80, 'b': 70, 'coord_origin': 'TOPLEFT',
                         }}]},
                    ],
                    'tables': [], 'pictures': [], 'key_value_items': [], 'groups': [],
                    'body': {'children': [{'$ref': '#/texts/1'}, {'$ref': '#/texts/0'}]},
                },
            },
            'engine_version': '2.52.0',
        }
        value = normalize_docling_document(payload)
        self.assertEqual(value['pages'], [{'number': 1, 'width': 612.0, 'height': 792.0}])
        self.assertEqual(value['readingOrder'], ['#/texts/1', '#/texts/0'])
        self.assertEqual(value['blocks'][1]['latex'], r'E=mc^2')
        self.assertIsNone(value['blocks'][1]['text'])
        self.assertEqual(value['blocks'][0]['region'], {
            'left': 10.0, 'top': 20.0, 'right': 100.0, 'bottom': 40.0,
            'coordOrigin': 'TOPLEFT',
        })
        self.assertEqual(normalize_docling_markdown(payload), '# Paper\n\n$$E=mc^2$$')

    def test_official_shaped_fixture_preserves_headings_tables_figures_and_formula_original(self):
        fixture = Path(__file__).resolve().parent / 'contracts' / 'fixtures' / 'docling-serve-v1-structured-response.json'
        payload = json.loads(fixture.read_text(encoding='utf-8'))

        value = normalize_docling_document(payload)

        blocks = {block['id']: block for block in value['blocks']}
        self.assertEqual(value['schemaId'], 'gb.document-structure.v1')
        self.assertEqual(value['readingOrder'][:4], [
            '#/texts/0', '#/tables/0', '#/pictures/0', '#/texts/2',
        ])
        self.assertEqual(blocks['#/texts/0']['kind'], 'section_header')
        self.assertEqual(blocks['#/tables/0']['text'], 'Quantity | Value | Energy | mc^2')
        self.assertEqual(blocks['#/pictures/0']['kind'], 'picture')
        self.assertEqual(blocks['#/pictures/0']['text'], 'Figure 1: Experimental geometry.')
        self.assertEqual(blocks['#/pictures/0']['page'], 1)
        self.assertEqual(blocks['#/pictures/0']['region']['left'], 72.0)
        self.assertNotIn('image', blocks['#/pictures/0'])
        self.assertEqual(blocks['#/texts/2']['latex'], r'E=mc^2')
        self.assertIsNone(blocks['#/texts/2']['text'])
        self.assertIn('| Quantity | Value |', normalize_docling_markdown(payload))

    def test_official_docling_rejects_failed_or_malformed_outputs(self):
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'failure', 'document': {'json_content': {}}})
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'success', 'document': {'json_content': 'not json'}})
        with self.assertRaises(IngestionContractError):
            normalize_docling_markdown({'status': 'success', 'document': {'md_content': None}})
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'document': {'pages': [], 'blocks': []}})
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'unexpected', 'document': {'pages': [], 'blocks': []}})

    def test_docling_page_ceiling_is_enforced_for_official_and_legacy_shapes(self):
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'success', 'document': {
                'pages': [{'number': index + 1} for index in range(501)], 'blocks': [],
            }})
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'success', 'document': {'json_content': {
                'pages': {str(index + 1): {'page_no': index + 1} for index in range(501)},
                'texts': [], 'tables': [], 'pictures': [], 'key_value_items': [], 'groups': [],
                'body': {'children': []},
            }}})

    def test_official_docling_traverses_deep_group_graph_without_recursion(self):
        group_count = 1_500
        groups = [
            {
                'self_ref': f'#/groups/{index}',
                'children': [{'$ref': (
                    f'#/groups/{index + 1}' if index + 1 < group_count else '#/texts/0'
                )}],
            }
            for index in range(group_count)
        ]
        payload = {'status': 'success', 'document': {'json_content': {
            'pages': {'1': {'page_no': 1}},
            'texts': [{'self_ref': '#/texts/0', 'label': 'text', 'text': 'deep'}],
            'tables': [], 'pictures': [], 'key_value_items': [],
            'groups': groups,
            'body': {'children': [{'$ref': '#/groups/0'}]},
        }}}

        value = normalize_docling_document(payload)

        self.assertEqual(value['readingOrder'], ['#/texts/0'])

    def test_docling_geometry_rejects_boolean_pages_bad_dimensions_and_out_of_bounds_regions(self):
        invalid_documents = [
            {'pages': [{'number': True}], 'blocks': []},
            {'pages': [{'number': 1}, {'number': 1}], 'blocks': []},
            {'pages': [{'number': 1, 'width': 0, 'height': 10}], 'blocks': []},
            {'pages': [{'number': 1, 'width': 100, 'height': 100}], 'blocks': [{
                'kind': 'text', 'text': 'x', 'page': 2,
            }]},
            {'pages': [{'number': 1, 'width': 100, 'height': 100}], 'blocks': [{
                'kind': 'text', 'text': 'x', 'page': 1,
                'region': {'x': -1, 'y': 0, 'width': 10, 'height': 10},
            }]},
            {'pages': [{'number': 1, 'width': 100, 'height': 100}], 'blocks': [{
                'kind': 'text', 'text': 'x', 'page': 1,
                'region': {'left': 80, 'top': 10, 'right': 20, 'bottom': 30},
            }]},
        ]
        for document in invalid_documents:
            with self.subTest(document=document), self.assertRaises(IngestionContractError):
                normalize_docling_document({'status': 'success', 'document': document})
        with self.assertRaises(IngestionContractError):
            normalize_docling_document({'status': 'success', 'document': {'json_content': {
                'pages': {'1': {'page_no': 1, 'size': {'width': 100, 'height': 100}}},
                'texts': [{
                    'self_ref': '#/texts/0', 'label': 'text', 'text': 'outside',
                    'prov': [{'page_no': 1, 'bbox': {
                        'l': 0, 't': 10, 'r': 101, 'b': 20, 'coord_origin': 'BOTTOMLEFT',
                    }}],
                }],
                'tables': [], 'pictures': [], 'key_value_items': [], 'groups': [],
                'body': {'children': [{'$ref': '#/texts/0'}]},
            }}})

    def test_fallback_selection_is_format_declared_and_plain_text_is_utf8_only(self):
        self.assertEqual(fallback_plugin_for_filename('paper.pdf'), 'markitdown')
        self.assertEqual(fallback_plugin_for_filename('document.docx'), 'markitdown')
        self.assertEqual(fallback_plugin_for_filename('paper.html'), 'markitdown')
        self.assertIsNone(fallback_plugin_for_filename('paper.xhtml'))
        self.assertIsNone(fallback_plugin_for_filename('archive.zip'))
        self.assertEqual(fallback_plugin_for_filename('notes.md'), 'plain-text')
        self.assertIsNone(fallback_plugin_for_filename('archive.bin'))
        self.assertEqual(normalize_plain_text_document('notes.md', b'# Notes'), '# Notes')
        with self.assertRaises(IngestionContractError):
            normalize_plain_text_document('notes.md', b'\xff')

    def test_representation_hash_is_of_exact_normalized_content(self):
        markdown = normalize_markitdown_document({'markdown': '# Exact\n'})
        self.assertEqual(
            representation_content_sha256('markdown', markdown),
            hashlib.sha256(markdown.encode('utf-8')).hexdigest(),
        )

    def test_transform_identity_changes_with_explicit_config_revision(self):
        current = transform_request_hash('revision-1', 'a' * 64)
        with patch('durable_ingestion.TRANSFORM_CONFIG_REVISION', 'next-config'):
            changed = transform_request_hash('revision-1', 'a' * 64)
        self.assertNotEqual(current, changed)
        self.assertNotEqual(
            transform_request_hash('revision-1', 'a' * 64, 'adapter-set-1'),
            transform_request_hash('revision-1', 'a' * 64, 'adapter-set-2'),
        )
        legacy = transform_request_hash('revision-1', 'a' * 64, 'adapter-set-1')
        self.assertEqual(
            legacy,
            transform_request_hash('revision-1', 'a' * 64, 'adapter-set-1', None),
        )
        self.assertNotEqual(
            legacy,
            transform_request_hash('revision-1', 'a' * 64, 'adapter-set-1', 'b' * 64),
        )
        with self.assertRaises(IngestionContractError):
            transform_request_hash('revision-1', 'a' * 64, 'adapter-set-1', 'not-a-hash')


if __name__ == '__main__':
    unittest.main()

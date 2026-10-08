"""Exact, side-effect-free contracts for durable document ingestion."""

from __future__ import annotations

import hashlib
import base64
import io
import json
import math
import mimetypes
import re
import struct
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
import xml.parsers.expat as expat
from pathlib import Path
from typing import Any, List, Literal, Optional, TypedDict
from urllib.parse import urlsplit, urlunsplit

MAX_DOCUMENT_BYTES = 100_000_000
MAX_RASTER_IMAGE_BYTES = 20 * 1024 * 1024
MAX_RASTER_IMAGE_DIMENSION = 8192
MAX_RASTER_IMAGE_PIXELS = 16_777_216
MAX_RASTER_IMAGE_CHANNELS = 4
MAX_RASTER_IMAGE_MANIFEST_HEADER_CHARS = 3_000
MAX_AUDIO_ORIGINAL_BYTES = 20 * 1024 * 1024
MAX_IMPORT_METADATA_BYTES = 6_000
MAX_IMPORT_METADATA_HEADER_CHARS = 8_000
MAX_TRANSFORM_BYTES = 25 * 1024 * 1024
MAX_TRANSFORM_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_MARKDOWN_CHARS = 8_000_000
MAX_DOCLING_PAGES = 500
IMPORT_SCHEMA = "gb.document.import.v1"
RASTER_IMAGE_SCHEMA = "gb.raster-image.v1"
AUDIO_ORIGINAL_SCHEMA = "gb.audio-original.v1"
STRUCTURE_SCHEMA = "gb.document-structure.v1"
TRANSFORM_SCHEMA = "gb.document.transform.v1"
TRANSFORM_PIPELINE_VERSION = "galaxy-document-transform-v1"
TRANSFORM_CONFIG_REVISION = "docling-json-markdown-embedded-images-v3"
ARXIV_ID = re.compile(r"^(?:[a-z-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(v\d+)?$", re.I)
# The durable paper lane deliberately exposes only PDF to the rich fallback.
# The converter service may support more formats, but that is not an ingestion
# permission boundary and archives/active formats must not enter through it.
MARKITDOWN_EXTENSIONS = frozenset({".pdf", ".docx", ".html", ".htm"})
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_DOCX_BYTES = MAX_TRANSFORM_BYTES
MAX_DOCX_ENTRIES = 4_096
MAX_DOCX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_DOCX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_DOCX_COMPRESSION_RATIO = 200
DOCX_REQUIRED_PARTS = frozenset({"[Content_Types].xml", "_rels/.rels", "word/document.xml"})
DOCX_ACTIVE_PART = re.compile(
    r"(?:^|/)(?:activeX|embeddings|oleObject)(?:/|$)|(?:^|/)vba(?:Data\.xml|Project\.bin)$|\.(?:exe|dll|com|msi|js|mjs|cjs|vbs|vbe|ps1|bat|cmd|scr)$",
    re.I,
)
DOCX_ACTIVE_CONTENT_TYPE = re.compile(
    r"macroenabled|vba|activex|oleobject|javascript|ecmascript|script|executable|x-msdownload|octet-stream",
    re.I,
)
DOCX_CONTENT_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$")
DOCX_ALLOWED_CONTENT_TYPES = frozenset({
    "application/xml",
    "text/xml",
    "application/vnd.openxmlformats-package.relationships+xml",
    "image/png", "image/jpeg", "image/gif", "image/tiff", "image/bmp",
    "application/vnd.ms-word.styleswitheffects+xml",
    "application/vnd.ms-office.themeoverride+xml",
})
DOCX_RELATIONSHIP_NAMESPACES = frozenset({
    "http://schemas.openxmlformats.org/package/2006/relationships",
    "http://purl.oclc.org/ooxml/package/relationships",
})
DOCX_OFFICE_RELATIONSHIP_TYPES = {
    "http://schemas.openxmlformats.org/package/2006/relationships":
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "http://purl.oclc.org/ooxml/package/relationships":
        "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
}
DOCX_DOCUMENT_ROOTS = frozenset({
    "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}document",
    "{http://purl.oclc.org/ooxml/wordprocessingml/main}document",
})
PLAIN_TEXT_EXTENSIONS = frozenset({".md", ".markdown", ".mdx", ".txt"})
RASTER_IMAGE_FORMATS = {
    "png": {"extensions": frozenset({".png"}), "mediaType": "image/png"},
    "jpeg": {"extensions": frozenset({".jpg", ".jpeg"}), "mediaType": "image/jpeg"},
    "webp": {"extensions": frozenset({".webp"}), "mediaType": "image/webp"},
    "gif": {"extensions": frozenset({".gif"}), "mediaType": "image/gif"},
}
RASTER_IMAGE_MEDIA_TYPES = frozenset(value["mediaType"] for value in RASTER_IMAGE_FORMATS.values())
AUDIO_VIDEO_EXTENSIONS = frozenset({
    ".aac", ".avi", ".flac", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4",
    ".oga", ".ogg", ".opus", ".wav", ".weba", ".webm",
})


class IngestionContractError(ValueError):
    pass


def docx_candidate(filename: str, supplied: Optional[str]) -> bool:
    declared = (supplied or "").split(";", 1)[0].strip().lower()
    return Path(filename).suffix.lower() == ".docx" or declared == DOCX_MEDIA_TYPE


def _safe_docx_part_name(name: str) -> bool:
    if not name or len(name) > 1_024 or "\\" in name or name.startswith("/"):
        return False
    if re.match(r"^[A-Za-z]:", name) or re.search(r"[\x00-\x1f\x7f-\x9f]", name):
        return False
    material = name[:-1] if name.endswith("/") else name
    return bool(material) and all(segment not in {"", ".", ".."} for segment in material.split("/"))


def _decode_docx_part_name(value: bytes, utf8: bool) -> str:
    if not 1 <= len(value) <= 1_024:
        raise IngestionContractError("DOCX part names are invalid")
    try:
        name = value.decode("utf-8" if utf8 else "ascii", errors="strict")
    except UnicodeDecodeError as error:
        raise IngestionContractError("DOCX part names are invalid") from error
    if not _safe_docx_part_name(name):
        raise IngestionContractError("DOCX part names are invalid")
    return name


def _docx_xml(value: bytes, label: str) -> ET.Element:
    if len(value) > MAX_DOCX_ENTRY_BYTES:
        raise IngestionContractError(f"DOCX {label} XML is invalid")
    parser = expat.ParserCreate()

    def reject_declaration(*_args):
        raise IngestionContractError(f"DOCX {label} XML declarations are not supported")

    parser.StartDoctypeDeclHandler = reject_declaration
    parser.EntityDeclHandler = reject_declaration
    parser.ExternalEntityRefHandler = lambda *_args: 0
    try:
        parser.Parse(value, True)
        return ET.fromstring(value)
    except (ET.ParseError, expat.ExpatError) as error:
        raise IngestionContractError(f"DOCX {label} XML is invalid") from error


def validate_docx_package(content: bytes, filename: str, supplied: Optional[str]) -> str:
    """Validate strict non-macro OOXML without extracting files to disk."""
    declared = (supplied or "").split(";", 1)[0].strip().lower()
    if Path(filename).suffix.lower() != ".docx":
        raise IngestionContractError("DOCX files must use the .docx extension")
    if declared and declared != DOCX_MEDIA_TYPE:
        raise IngestionContractError("DOCX media type does not match its filename")
    if not 1 <= len(content) <= MAX_DOCX_BYTES:
        raise IngestionContractError("DOCX exceeds the 25 MiB import limit")
    eocd = content.rfind(b"PK\x05\x06", max(0, len(content) - 65_557))
    if eocd < 0 or eocd + 22 > len(content):
        raise IngestionContractError("DOCX ZIP directory is invalid")
    disk, central_disk, entries_disk, entries_total, central_size, central_offset, comment_length = struct.unpack_from(
        "<HHHHIIH", content, eocd + 4,
    )
    if (disk != 0 or central_disk != 0 or entries_disk != entries_total
            or entries_total < 1 or entries_total > MAX_DOCX_ENTRIES
            or entries_total == 0xFFFF or central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF
            or central_offset + central_size != eocd or eocd + 22 + comment_length != len(content)):
        raise IngestionContractError("DOCX ZIP directory is invalid")
    central_cursor = central_offset
    central_records = []
    for _index in range(entries_total):
        if central_cursor + 46 > eocd or content[central_cursor:central_cursor + 4] != b"PK\x01\x02":
            raise IngestionContractError("DOCX ZIP directory is invalid")
        flags, method = struct.unpack_from("<HH", content, central_cursor + 8)
        crc = struct.unpack_from("<I", content, central_cursor + 16)[0]
        compressed_size, uncompressed_size = struct.unpack_from("<II", content, central_cursor + 20)
        name_length, extra_length, entry_comment_length, entry_disk = struct.unpack_from(
            "<HHHH", content, central_cursor + 28,
        )
        local_offset = struct.unpack_from("<I", content, central_cursor + 42)[0]
        entry_end = central_cursor + 46 + name_length + extra_length + entry_comment_length
        if (entry_end > eocd or entry_disk != 0 or local_offset == 0xFFFFFFFF
                or compressed_size == 0xFFFFFFFF or uncompressed_size == 0xFFFFFFFF
                or flags & 0x2041 or method not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}):
            raise IngestionContractError("ZIP64 and multidisk DOCX packages are not supported")
        name = content[central_cursor + 46:central_cursor + 46 + name_length]
        decoded_name = _decode_docx_part_name(name, bool(flags & 0x0800))
        extra = content[central_cursor + 46 + name_length:central_cursor + 46 + name_length + extra_length]
        extra_cursor = 0
        while extra_cursor < len(extra):
            if extra_cursor + 4 > len(extra):
                raise IngestionContractError("DOCX ZIP extra fields are invalid")
            extra_id, extra_size = struct.unpack_from("<HH", extra, extra_cursor)
            extra_cursor += 4
            if extra_cursor + extra_size > len(extra):
                raise IngestionContractError("DOCX ZIP extra fields are invalid")
            if extra_id == 0x0001:
                raise IngestionContractError("ZIP64 and multidisk DOCX packages are not supported")
            extra_cursor += extra_size
        central_records.append((
            flags, method, crc, compressed_size, uncompressed_size, name, decoded_name, local_offset,
        ))
        central_cursor = entry_end
    if central_cursor != eocd:
        raise IngestionContractError("DOCX ZIP directory is invalid")
    local_ranges = []
    for flags, method, crc, compressed_size, uncompressed_size, name, _decoded_name, local_offset in central_records:
        if local_offset + 30 > central_offset or content[local_offset:local_offset + 4] != b"PK\x03\x04":
            raise IngestionContractError("DOCX local ZIP header is invalid")
        local_flags, local_method = struct.unpack_from("<HH", content, local_offset + 6)
        local_crc = struct.unpack_from("<I", content, local_offset + 14)[0]
        local_compressed, local_uncompressed = struct.unpack_from("<II", content, local_offset + 18)
        local_name_length, local_extra_length = struct.unpack_from("<HH", content, local_offset + 26)
        local_name_start = local_offset + 30
        local_name_end = local_name_start + local_name_length
        local_extra_end = local_name_end + local_extra_length
        data_end = local_extra_end + compressed_size
        if (local_flags != flags or local_method != method or local_name_length != len(name)
                or content[local_name_start:local_name_end] != name or data_end > central_offset):
            raise IngestionContractError("DOCX local ZIP header does not match its directory")
        if not flags & 0x0008 and (
            local_crc != crc or local_compressed != compressed_size or local_uncompressed != uncompressed_size
        ):
            raise IngestionContractError("DOCX local ZIP sizes do not match its directory")
        local_extra = content[local_name_end:local_extra_end]
        extra_cursor = 0
        while extra_cursor < len(local_extra):
            if extra_cursor + 4 > len(local_extra):
                raise IngestionContractError("DOCX ZIP extra fields are invalid")
            extra_id, extra_size = struct.unpack_from("<HH", local_extra, extra_cursor)
            extra_cursor += 4
            if extra_cursor + extra_size > len(local_extra) or extra_id == 0x0001:
                raise IngestionContractError("ZIP64 DOCX packages are not supported")
            extra_cursor += extra_size
        entry_end = data_end
        if flags & 0x0008:
            if (local_crc not in {0, crc} or local_compressed not in {0, compressed_size}
                    or local_uncompressed not in {0, uncompressed_size}):
                raise IngestionContractError("DOCX local ZIP data descriptor is invalid")
            if content[entry_end:entry_end + 4] == b"PK\x07\x08":
                entry_end += 4
            if entry_end + 12 > central_offset:
                raise IngestionContractError("DOCX local ZIP data descriptor is invalid")
            descriptor = struct.unpack_from("<III", content, entry_end)
            if descriptor != (crc, compressed_size, uncompressed_size):
                raise IngestionContractError("DOCX local ZIP data descriptor is invalid")
            entry_end += 12
        local_ranges.append((local_offset, entry_end))
    local_ranges.sort()
    if local_ranges[0][0] != 0 or local_ranges[-1][1] != central_offset:
        raise IngestionContractError("DOCX ZIP contains opaque data outside its parts")
    for previous, current in zip(local_ranges, local_ranges[1:]):
        if current[0] != previous[1]:
            raise IngestionContractError("DOCX ZIP contains overlapping or opaque part data")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content), "r", allowZip64=False)
        entries = archive.infolist()
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        raise IngestionContractError("DOCX ZIP package is invalid") from error
    if len(entries) != entries_total:
        archive.close()
        raise IngestionContractError("DOCX ZIP entry count is invalid")
    names: set[str] = set()
    folded_names: set[str] = set()
    part_names: set[str] = set()
    expanded = 0
    required_content: dict[str, bytes] = {}
    try:
        for entry, central_record in zip(entries, central_records):
            name = entry.filename
            expected_name = central_record[6]
            if entry.orig_filename != expected_name or name != expected_name:
                raise IngestionContractError("DOCX part names are invalid")
            folded = name.casefold()
            if not _safe_docx_part_name(name) or name in names or folded in folded_names:
                raise IngestionContractError("DOCX part names are invalid")
            names.add(name)
            folded_names.add(folded)
            if DOCX_ACTIVE_PART.search(name):
                raise IngestionContractError("Macro, ActiveX, and embedded executable DOCX parts are not supported")
            if entry.flag_bits & 0x2041:
                raise IngestionContractError("Encrypted DOCX parts are not supported")
            if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise IngestionContractError("DOCX compression method is unsupported")
            if entry.header_offset == 0xFFFFFFFF:
                raise IngestionContractError("ZIP64 and multidisk DOCX packages are not supported")
            unix_type = (entry.external_attr >> 16) & 0xF000 if entry.create_system == 3 else 0
            if unix_type not in {0, 0x8000, 0x4000} or unix_type == 0xA000:
                raise IngestionContractError("DOCX special filesystem entries are not supported")
            if entry.is_dir():
                if entry.file_size != 0 or entry.compress_size != 0:
                    raise IngestionContractError("DOCX directory entry is invalid")
                continue
            if name.endswith("/") or entry.file_size > MAX_DOCX_ENTRY_BYTES:
                raise IngestionContractError("DOCX expanded entry exceeds the limit")
            part_names.add(name)
            expanded += entry.file_size
            if expanded > MAX_DOCX_EXPANDED_BYTES:
                raise IngestionContractError("DOCX expanded content exceeds the limit")
            if entry.file_size > 1_048_576 and (
                entry.compress_size == 0 or entry.file_size / entry.compress_size > MAX_DOCX_COMPRESSION_RATIO
            ):
                raise IngestionContractError("DOCX compression ratio exceeds the limit")
            decoded = bytearray()
            with archive.open(entry, "r") as stream:
                total = 0
                while True:
                    chunk = stream.read(65_536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > entry.file_size or total > MAX_DOCX_ENTRY_BYTES:
                        raise IngestionContractError("DOCX expanded entry exceeds the limit")
                    if name in DOCX_REQUIRED_PARTS:
                        decoded.extend(chunk)
                if total != entry.file_size:
                    raise IngestionContractError("DOCX expanded entry size is invalid")
            if name in DOCX_REQUIRED_PARTS:
                required_content[name] = bytes(decoded)
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise IngestionContractError("DOCX ZIP package is invalid") from error
    finally:
        archive.close()
    if set(required_content) != DOCX_REQUIRED_PARTS:
        raise IngestionContractError("DOCX package is missing required Word parts")

    content_types = _docx_xml(required_content["[Content_Types].xml"], "content types")
    if content_types.tag != "{http://schemas.openxmlformats.org/package/2006/content-types}Types":
        raise IngestionContractError("DOCX content types are invalid")
    main_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    content_type_namespace = "http://schemas.openxmlformats.org/package/2006/content-types"
    override_tag = f"{{{content_type_namespace}}}Override"
    default_tag = f"{{{content_type_namespace}}}Default"
    overrides = {}
    defaults = {}
    for item in content_types:
        if item.tag == override_tag:
            part_name = item.attrib.get("PartName")
            content_type = item.attrib.get("ContentType")
            if (not isinstance(part_name, str) or not part_name.startswith("/")
                    or not _safe_docx_part_name(part_name[1:]) or part_name.casefold() in overrides
                    or not isinstance(content_type, str) or not DOCX_CONTENT_TYPE.fullmatch(content_type)
                    or DOCX_ACTIVE_CONTENT_TYPE.search(content_type)):
                raise IngestionContractError("DOCX content types are invalid")
            overrides[part_name.casefold()] = content_type
        elif item.tag == default_tag:
            extension = item.attrib.get("Extension")
            content_type = item.attrib.get("ContentType")
            if (not isinstance(extension, str) or not re.fullmatch(r"[A-Za-z0-9]{1,32}", extension)
                    or extension.casefold() in defaults or not isinstance(content_type, str)
                    or not DOCX_CONTENT_TYPE.fullmatch(content_type)
                    or DOCX_ACTIVE_CONTENT_TYPE.search(content_type)):
                raise IngestionContractError("DOCX content types are invalid")
            defaults[extension.casefold()] = content_type
        else:
            raise IngestionContractError("DOCX content types are invalid")
    if overrides.get("/word/document.xml") != main_type:
        raise IngestionContractError("DOCX main content type is invalid")
    relationship_content_type = "application/vnd.openxmlformats-package.relationships+xml"
    for part_name in part_names:
        if part_name == "[Content_Types].xml":
            continue
        override_content_type = overrides.get(f"/{part_name}".casefold())
        extension = part_name.rsplit(".", 1)[1].casefold() if "." in part_name.rsplit("/", 1)[-1] else ""
        content_type = override_content_type or defaults.get(extension)
        normalized_content_type = content_type.casefold() if isinstance(content_type, str) else ""
        if (not normalized_content_type or DOCX_ACTIVE_CONTENT_TYPE.search(normalized_content_type)
                or not (
                    normalized_content_type in DOCX_ALLOWED_CONTENT_TYPES
                    or normalized_content_type.startswith("application/vnd.openxmlformats-officedocument.")
                    or normalized_content_type.startswith("application/vnd.openxmlformats-package.")
                )):
            raise IngestionContractError("DOCX part content type is missing or unsupported")
        if part_name.casefold().endswith(".rels") and normalized_content_type != relationship_content_type:
            raise IngestionContractError("DOCX relationship part content type is invalid")
        if (part_name.casefold().startswith("word/") and extension == "xml"
                and override_content_type is None):
            raise IngestionContractError("DOCX Word XML parts require explicit content types")
        if extension == "bin" and not (
            re.fullmatch(r"word/printerSettings/printerSettings\d+\.bin", part_name, re.I)
            and normalized_content_type == (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.printersettings"
            )
        ):
            raise IngestionContractError("DOCX binary part is unsupported")

    relationships = _docx_xml(required_content["_rels/.rels"], "relationships")
    relationship_namespace = next((
        namespace for namespace in DOCX_RELATIONSHIP_NAMESPACES
        if relationships.tag == f"{{{namespace}}}Relationships"
    ), None)
    if relationship_namespace is None:
        raise IngestionContractError("DOCX office document relationship is invalid")
    relationship_tag = f"{{{relationship_namespace}}}Relationship"
    if any(item.tag != relationship_tag for item in relationships):
        raise IngestionContractError("DOCX office document relationship is invalid")
    expected_office_type = DOCX_OFFICE_RELATIONSHIP_TYPES[relationship_namespace]
    office = [item for item in relationships if item.attrib.get("Type") == expected_office_type]
    if (len(office) != 1 or office[0].attrib.get("TargetMode") not in {None, "Internal"}
            or office[0].attrib.get("Type") != expected_office_type):
        raise IngestionContractError("DOCX office document relationship is invalid")
    target = office[0].attrib.get("Target", "").replace("\\", "/").lstrip("/")
    if target != "word/document.xml":
        raise IngestionContractError("DOCX office document relationship is invalid")
    document = _docx_xml(required_content["word/document.xml"], "document")
    if document.tag not in DOCX_DOCUMENT_ROOTS:
        raise IngestionContractError("DOCX main document XML is invalid")
    return DOCX_MEDIA_TYPE


class GalaxyDocumentBlock(TypedDict):
    id: str
    kind: str
    order: int
    text: Optional[str]
    latex: Optional[str]
    page: Optional[int]
    region: Optional[dict]


class GalaxyDocumentStructure(TypedDict):
    schemaId: Literal["gb.document-structure.v1"]
    pages: List[Any]
    blocks: List[GalaxyDocumentBlock]
    readingOrder: List[str]


class DoclingResponseMetadata(TypedDict):
    status: Literal["success", "partial_success"]
    errorCount: int


class DurableImportResponse(TypedDict):
    schemaId: Literal["gb.document.import.v1"]
    persisted: Literal[True]
    ref: str
    document_id: str
    revision_id: str
    artifact_id: str
    source_id: str
    title: str
    display_filename: str
    version: int
    content_sha256: str
    revision_sha256: str
    byte_size: int
    media_type: str
    source_kind: Literal["upload", "url", "arxiv", "legacy-paper", "datasource"]
    original_filename: Optional[str]
    source_uri: Optional[str]
    ingestion_plan: Optional[dict]
    replayed: bool
    deduplicatedArtifact: bool


class DurableImportMetadata(TypedDict):
    title: str
    filename: str
    sourceKind: Literal["upload", "url", "arxiv", "legacy-paper", "datasource"]
    sourceUri: Optional[str]
    arxivId: Optional[str]
    ingestionPlan: Optional[dict]
    captureIntentSha256: Optional[str]


class RasterImageManifest(TypedDict):
    schemaId: Literal["gb.raster-image.v1"]
    format: Literal["png", "jpeg", "webp", "gif"]
    mediaType: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    width: int
    height: int
    channels: int
    frameCount: Literal[1]
    byteSize: int
    contentSha256: str


class AudioOriginalManifest(TypedDict):
    schemaId: Literal["gb.audio-original.v1"]
    container: Literal["webm"]
    codec: Literal["opus"]
    mediaType: Literal["audio/webm"]
    trackCount: Literal[1]
    channels: int
    byteSize: int
    contentSha256: str


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _raster_magic(content: bytes) -> Optional[str]:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "webp"
    return None


def normalize_raster_image_manifest(
    value: Any,
    *,
    filename: Optional[str] = None,
    media_type: Optional[str] = None,
    content_sha256: Optional[str] = None,
    byte_size: Optional[int] = None,
    content: Optional[bytes] = None,
) -> RasterImageManifest:
    keys = {
        "schemaId", "format", "mediaType", "width", "height", "channels", "frameCount",
        "byteSize", "contentSha256",
    }
    if not isinstance(value, dict) or set(value) != keys or value.get("schemaId") != RASTER_IMAGE_SCHEMA:
        raise IngestionContractError("raster image manifest shape is invalid")
    image_format = value.get("format")
    if image_format not in RASTER_IMAGE_FORMATS:
        raise IngestionContractError("raster image format is unsupported")
    image_type = RASTER_IMAGE_FORMATS[image_format]
    if value.get("mediaType") != image_type["mediaType"]:
        raise IngestionContractError("raster image media type does not match its format")
    width = value.get("width")
    height = value.get("height")
    channels = value.get("channels")
    frame_count = value.get("frameCount")
    manifest_byte_size = value.get("byteSize")
    manifest_sha256 = value.get("contentSha256")
    if any(isinstance(item, bool) or not isinstance(item, int) for item in (
        width, height, channels, frame_count, manifest_byte_size,
    )):
        raise IngestionContractError("raster image manifest dimensions are invalid")
    if not 1 <= width <= MAX_RASTER_IMAGE_DIMENSION or not 1 <= height <= MAX_RASTER_IMAGE_DIMENSION:
        raise IngestionContractError("raster image dimensions exceed the limit")
    if width * height > MAX_RASTER_IMAGE_PIXELS:
        raise IngestionContractError("raster image decoded pixel count exceeds the limit")
    if not 1 <= channels <= MAX_RASTER_IMAGE_CHANNELS:
        raise IngestionContractError("raster image channel count exceeds the limit")
    if frame_count != 1:
        raise IngestionContractError("animated raster images are not supported")
    if not 1 <= manifest_byte_size <= MAX_RASTER_IMAGE_BYTES:
        raise IngestionContractError("raster image exceeds the 20 MiB import limit")
    if not isinstance(manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
        raise IngestionContractError("raster image content hash is invalid")
    if filename is not None and Path(filename).suffix.lower() not in image_type["extensions"]:
        raise IngestionContractError("raster image filename does not match its decoded format")
    if media_type is not None and media_type != image_type["mediaType"]:
        raise IngestionContractError("raster image manifest is bound to a different media type")
    if content_sha256 is not None and content_sha256 != manifest_sha256:
        raise IngestionContractError("raster image manifest is bound to a different content hash")
    if byte_size is not None and byte_size != manifest_byte_size:
        raise IngestionContractError("raster image manifest is bound to a different byte size")
    if content is not None and _raster_magic(content) != image_format:
        raise IngestionContractError("raster image signature does not match its decoded format")
    return {
        "schemaId": RASTER_IMAGE_SCHEMA,
        "format": image_format,
        "mediaType": image_type["mediaType"],
        "width": width,
        "height": height,
        "channels": channels,
        "frameCount": 1,
        "byteSize": manifest_byte_size,
        "contentSha256": manifest_sha256,
    }


def decode_raster_image_manifest(value: Optional[str], **binding: Any) -> RasterImageManifest:
    encoded = value or ""
    if (not encoded or len(encoded) > MAX_RASTER_IMAGE_MANIFEST_HEADER_CHARS
            or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded)):
        raise IngestionContractError("raster image manifest header is invalid")
    try:
        raw = base64.b64decode(encoded + ("=" * (-len(encoded) % 4)), altchars=b"-_", validate=True)
        if len(raw) > 2_000:
            raise IngestionContractError("raster image manifest is too large")
        decoded = json.loads(raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IngestionContractError("raster image manifest must be base64url UTF-8 JSON") from error
    return normalize_raster_image_manifest(decoded, **binding)


_EBML = 0x1A45DFA3
_SEGMENT = 0x18538067
_DOC_TYPE = 0x4282
_INFO = 0x1549A966
_TRACKS = 0x1654AE6B
_TRACK_ENTRY = 0xAE
_TRACK_NUMBER = 0xD7
_TRACK_UID = 0x73C5
_TRACK_TYPE = 0x83
_CODEC_ID = 0x86
_CODEC_PRIVATE = 0x63A2
_CODEC_DELAY = 0x56AA
_SEEK_PRE_ROLL = 0x56BB
_AUDIO = 0xE1
_SAMPLING_FREQUENCY = 0xB5
_OUTPUT_SAMPLING_FREQUENCY = 0x78B5
_CHANNELS = 0x9F
_BIT_DEPTH = 0x6264
_CLUSTER = 0x1F43B675
_CLUSTER_TIMECODE = 0xE7
_SIMPLE_BLOCK = 0xA3
_VOID = 0xEC
_CRC32 = 0xBF
_MAX_WEBM_ELEMENTS = 100_000


def _ebml_vint(content: bytes, offset: int, maximum: int, preserve_marker: bool, label: str):
    if offset >= len(content):
        raise IngestionContractError(f"{label} is truncated")
    first = content[offset]
    length = 1
    marker = 0x80
    while length <= maximum and not first & marker:
        length += 1
        marker >>= 1
    if length > maximum or offset + length > len(content):
        raise IngestionContractError(f"{label} is invalid")
    value = first if preserve_marker else first & (marker - 1)
    for item in content[offset + 1:offset + length]:
        value = (value << 8) | item
    unknown = not preserve_marker and value == (1 << (7 * length)) - 1
    if not preserve_marker and not unknown and length > 1 and value < (1 << (7 * (length - 1))) - 1:
        raise IngestionContractError(f"{label} is not minimally encoded")
    return length, value, unknown


def _ebml_element(content: bytes, offset: int, boundary: int, *, allow_unknown=False):
    id_length, element_id, _ = _ebml_vint(content, offset, 4, True, "WebM element identifier")
    size_length, size, unknown = _ebml_vint(
        content, offset + id_length, 8, False, "WebM element size",
    )
    start = offset + id_length + size_length
    if unknown:
        if not allow_unknown:
            raise IngestionContractError("WebM contains an unsupported unknown-size element")
        return element_id, start, boundary, boundary, True
    end = start + size
    if end < start or end > boundary:
        raise IngestionContractError("WebM element exceeds its container")
    return element_id, start, end, end, False


def _ebml_children(content: bytes, start: int, end: int, state: dict):
    result = []
    offset = start
    while offset < end:
        state["count"] += 1
        if state["count"] > _MAX_WEBM_ELEMENTS:
            raise IngestionContractError("WebM contains too many elements")
        element = _ebml_element(content, offset, end)
        if element[3] <= offset:
            raise IngestionContractError("WebM element did not advance")
        result.append(element)
        offset = element[3]
    if offset != end:
        raise IngestionContractError("WebM container is truncated")
    return result


def _unknown_cluster_end(content: bytes, start: int, end: int, state: dict):
    children = []
    offset = start
    while offset < end:
        _, element_id, _ = _ebml_vint(content, offset, 4, True, "WebM element identifier")
        if element_id == _CLUSTER:
            return offset, children
        state["count"] += 1
        if state["count"] > _MAX_WEBM_ELEMENTS:
            raise IngestionContractError("WebM contains too many elements")
        element = _ebml_element(content, offset, end)
        if element[3] <= offset:
            raise IngestionContractError("WebM element did not advance")
        children.append(element)
        offset = element[3]
    if offset != end:
        raise IngestionContractError("WebM Cluster is truncated")
    return end, children


def _ebml_segment_children(content: bytes, start: int, end: int, state: dict):
    result = []
    offset = start
    while offset < end:
        state["count"] += 1
        if state["count"] > _MAX_WEBM_ELEMENTS:
            raise IngestionContractError("WebM contains too many elements")
        element = _ebml_element(content, offset, end, allow_unknown=True)
        if element[4]:
            if element[0] != _CLUSTER:
                raise IngestionContractError("Only WebM Cluster may use an unknown size inside Segment")
            boundary, children = _unknown_cluster_end(content, element[1], end, state)
            element = (element[0], element[1], boundary, boundary, True, children)
        if element[3] <= offset:
            raise IngestionContractError("WebM element did not advance")
        result.append(element)
        offset = element[3]
    if offset != end:
        raise IngestionContractError("WebM Segment is truncated")
    return result


def _ebml_uint(content: bytes, start: int, end: int, label: str) -> int:
    if not 1 <= end - start <= 8:
        raise IngestionContractError(f"{label} is invalid")
    return int.from_bytes(content[start:end], "big")


def _ebml_ascii(content: bytes, start: int, end: int) -> str:
    if any(item < 0x20 or item > 0x7E for item in content[start:end]):
        raise IngestionContractError("WebM text metadata is invalid")
    return content[start:end].decode("ascii")


def _ebml_float(content: bytes, start: int, end: int, label: str) -> float:
    size = end - start
    if size not in {4, 8}:
        raise IngestionContractError(f"{label} is invalid")
    value = struct.unpack(">f" if size == 4 else ">d", content[start:end])[0]
    if not math.isfinite(value) or value <= 0:
        raise IngestionContractError(f"{label} is invalid")
    return value


def _unique(fields: set, element_id: int, label: str):
    if element_id in fields:
        raise IngestionContractError(f"{label} is duplicated")
    fields.add(element_id)


def _opus_head(content: bytes, start: int, end: int):
    value = content[start:end]
    if len(value) != 19 or value[:8] != b"OpusHead" or value[8] != 1:
        raise IngestionContractError("WebM audio track requires an exact OpusHead version 1 header")
    channels = value[9]
    pre_skip = int.from_bytes(value[10:12], "little")
    input_rate = int.from_bytes(value[12:16], "little")
    if channels not in {1, 2} or input_rate not in {0, 48_000} or value[18] != 0:
        raise IngestionContractError("Opus identification header is outside the supported mono/stereo profile")
    return channels, pre_skip, input_rate


def _webm_audio(content: bytes, element, state: dict):
    fields = set()
    channels = None
    frequency = None
    for element_id, start, end, _, _ in _ebml_children(content, element[1], element[2], state):
        _unique(fields, element_id, "WebM Audio field")
        if element_id == _SAMPLING_FREQUENCY:
            frequency = _ebml_float(content, start, end, "WebM sampling frequency")
        elif element_id == _OUTPUT_SAMPLING_FREQUENCY:
            if _ebml_float(content, start, end, "WebM output sampling frequency") != 48_000:
                raise IngestionContractError("WebM output sampling frequency must be 48000 Hz")
        elif element_id == _CHANNELS:
            channels = _ebml_uint(content, start, end, "WebM channel count")
        elif element_id == _BIT_DEPTH:
            _ebml_uint(content, start, end, "WebM bit depth")
        else:
            raise IngestionContractError("WebM Audio contains an unsupported active element")
    if frequency != 48_000 or channels is None:
        raise IngestionContractError("WebM Audio must declare 48000 Hz and a channel count")
    return channels, frequency


def _webm_track(content: bytes, element, state: dict):
    fields = set()
    values = {}
    harmless = {_TRACK_UID, 0xB9, 0x88, 0x55AA, 0x9C, 0x23E383, 0x536E, 0x22B59C}
    for element_id, start, end, _, _ in _ebml_children(content, element[1], element[2], state):
        if element_id == _CRC32:
            raise IngestionContractError("CRC-32 elements are not supported")
        if element_id == _VOID:
            continue
        _unique(fields, element_id, "WebM TrackEntry field")
        if element_id in {_TRACK_NUMBER, _TRACK_TYPE, _CODEC_DELAY, _SEEK_PRE_ROLL}:
            values[element_id] = _ebml_uint(content, start, end, "WebM track field")
        elif element_id == _CODEC_ID:
            values[element_id] = _ebml_ascii(content, start, end)
        elif element_id == _CODEC_PRIVATE:
            values[element_id] = _opus_head(content, start, end)
        elif element_id == _AUDIO:
            values[element_id] = _webm_audio(content, (element_id, start, end, end, False), state)
        elif element_id in harmless:
            if element_id in {0x536E, 0x22B59C}:
                _ebml_ascii(content, start, end)
            else:
                flag = _ebml_uint(content, start, end, "WebM track field")
                if element_id in {0xB9, 0x88, 0x55AA, 0x9C} and flag not in {0, 1}:
                    raise IngestionContractError("WebM track flag is invalid")
                if element_id == 0x9C and flag != 0:
                    raise IngestionContractError("Laced WebM tracks are not supported")
                if element_id == _TRACK_UID and flag < 1:
                    raise IngestionContractError("WebM track UID is invalid")
        else:
            raise IngestionContractError("WebM TrackEntry contains an unsupported active element")
    if values.get(_TRACK_TYPE) == 1:
        raise IngestionContractError("Video tracks are not supported")
    if (values.get(_TRACK_NUMBER) != 1 or values.get(_TRACK_TYPE) != 2
            or values.get(_CODEC_ID) != "A_OPUS" or _CODEC_PRIVATE not in values
            or _AUDIO not in values):
        raise IngestionContractError("Every WebM track must be one Opus audio track")
    channels, pre_skip, input_rate = values[_CODEC_PRIVATE]
    audio_channels, frequency = values[_AUDIO]
    expected_delay = pre_skip * 1_000_000_000 / 48_000
    if (audio_channels != channels or (input_rate != 0 and frequency != input_rate) or not expected_delay.is_integer()
            or (_CODEC_DELAY in values and values[_CODEC_DELAY] != int(expected_delay))
            or (_SEEK_PRE_ROLL in values and values[_SEEK_PRE_ROLL] != 80_000_000)):
        raise IngestionContractError("WebM Opus track metadata is inconsistent")
    return 1, channels


def _opus_frame_duration_units(toc: int) -> int:
    configuration = toc >> 3
    if configuration < 12:
        return (4, 8, 16, 24)[configuration & 3]
    if configuration < 16:
        return (4, 8)[configuration & 1]
    return (1, 2, 4, 8)[configuration & 3]


def _opus_frame_length(packet: bytes, offset: int, boundary: int):
    if offset >= boundary:
        return None
    first = packet[offset]
    if first < 252:
        return first, offset + 1
    if offset + 1 >= boundary:
        return None
    length = first + 4 * packet[offset + 1]
    return (length, offset + 2) if length <= 1275 else None


def _opus_packet_valid(packet: bytes) -> bool:
    if len(packet) < 1:
        return False
    code = packet[0] & 3
    remaining = len(packet) - 1
    duration_units = _opus_frame_duration_units(packet[0])
    if code == 0:
        return remaining <= 1275
    if code == 1:
        return duration_units * 2 <= 48 and remaining % 2 == 0 and remaining // 2 <= 1275
    if code == 2:
        if duration_units * 2 > 48:
            return False
        first = _opus_frame_length(packet, 1, len(packet))
        if first is None:
            return False
        first_length, offset = first
        second_length = len(packet) - offset - first_length
        return 0 <= second_length <= 1275
    if len(packet) < 2:
        return False
    control = packet[1]
    frames = control & 0x3F
    if not 1 <= frames <= 48 or duration_units * frames > 48:
        return False
    offset = 2
    padding = 0
    if control & 0x40:
        while True:
            if offset >= len(packet):
                return False
            amount = packet[offset]
            offset += 1
            padding += 254 if amount == 255 else amount
            if amount != 255:
                break
    if padding > len(packet) - offset:
        return False
    payload_end = len(packet) - padding
    if not control & 0x80:
        framed_length = payload_end - offset
        return framed_length % frames == 0 and framed_length // frames <= 1275
    declared = 0
    for _ in range(frames - 1):
        parsed = _opus_frame_length(packet, offset, payload_end)
        if parsed is None:
            return False
        length, offset = parsed
        declared += length
        if declared > payload_end - offset:
            return False
    last_length = payload_end - offset - declared
    return 0 <= last_length <= 1275


def _webm_cluster(content: bytes, element, state: dict, track_number: int, previous: int):
    timecode = None
    blocks = 0
    last = previous
    children = element[5] if len(element) > 5 else _ebml_children(content, element[1], element[2], state)
    for element_id, start, end, _, *_ in children:
        if element_id == _CRC32:
            raise IngestionContractError("CRC-32 elements are not supported")
        if element_id == _VOID:
            continue
        if element_id == _CLUSTER_TIMECODE:
            if timecode is not None:
                raise IngestionContractError("WebM Cluster timecode is duplicated")
            timecode = _ebml_uint(content, start, end, "WebM Cluster timecode")
        elif element_id == _SIMPLE_BLOCK:
            if timecode is None:
                raise IngestionContractError("WebM Cluster timecode must precede blocks")
            length, block_track, unknown = _ebml_vint(content, start, 8, False, "WebM block track number")
            header = start + length
            if unknown or block_track != track_number or header + 3 > end:
                raise IngestionContractError("WebM block references an undeclared track")
            relative = int.from_bytes(content[header:header + 2], "big", signed=True)
            if content[header + 2] & 0x06:
                raise IngestionContractError("Laced WebM blocks are not supported")
            absolute = timecode + relative
            if absolute < 0 or absolute < last or not _opus_packet_valid(content[header + 3:end]):
                raise IngestionContractError("WebM block timestamp or Opus packet is invalid")
            last = absolute
            blocks += 1
        else:
            raise IngestionContractError("WebM Cluster contains an unsupported active element")
    if timecode is None or blocks < 1:
        raise IngestionContractError("WebM Cluster contains no playable audio block")
    return last


def inspect_webm_opus_audio(content: bytes):
    if not 1 <= len(content) <= MAX_AUDIO_ORIGINAL_BYTES:
        raise IngestionContractError("WebM/Opus audio exceeds the 20 MiB import limit")
    state = {"count": 1}
    header = _ebml_element(content, 0, len(content))
    if header[0] != _EBML:
        raise IngestionContractError("audio original is not an EBML WebM file")
    fields = {}
    for element in _ebml_children(content, header[1], header[2], state):
        if element[0] == _CRC32:
            raise IngestionContractError("CRC-32 elements are not supported")
        if element[0] == _VOID:
            continue
        if element[0] in fields:
            raise IngestionContractError("EBML header field is duplicated")
        fields[element[0]] = element
    required = {0x4286: 1, 0x42F7: 1, 0x42F2: 4, 0x42F3: 8}
    if any(item not in fields or _ebml_uint(content, fields[item][1], fields[item][2], "EBML header") != value
           for item, value in required.items()):
        raise IngestionContractError("EBML header version or length profile is unsupported")
    if (_DOC_TYPE not in fields or _ebml_ascii(content, fields[_DOC_TYPE][1], fields[_DOC_TYPE][2]) != "webm"
            or 0x4287 not in fields or 0x4285 not in fields
            or _ebml_uint(content, fields[0x4287][1], fields[0x4287][2], "DocType version") > 4
            or _ebml_uint(content, fields[0x4285][1], fields[0x4285][2], "DocType read version") > 2
            or len(fields) != 7):
        raise IngestionContractError("WebM DocType profile is unsupported")
    if header[3] >= len(content):
        raise IngestionContractError("WebM Segment is missing")
    segment = _ebml_element(content, header[3], len(content), allow_unknown=True)
    if segment[0] != _SEGMENT or (not segment[4] and segment[3] != len(content)):
        raise IngestionContractError("WebM must contain one complete Segment")
    info = tracks = None
    clusters = []
    saw_cluster = False
    for element in _ebml_segment_children(content, segment[1], segment[2], state):
        element_id = element[0]
        if element_id == _CRC32:
            raise IngestionContractError("CRC-32 elements are not supported")
        if element_id == _VOID:
            continue
        if element_id == _INFO:
            if info is not None or saw_cluster:
                raise IngestionContractError("WebM Info is duplicated or out of order")
            info = element
        elif element_id == _TRACKS:
            if tracks is not None or saw_cluster:
                raise IngestionContractError("WebM Tracks is duplicated or out of order")
            tracks = element
        elif element_id == _CLUSTER:
            if info is None or tracks is None:
                raise IngestionContractError("WebM metadata must precede Cluster data")
            saw_cluster = True
            clusters.append(element)
        else:
            raise IngestionContractError("WebM Segment contains an unsupported active element")
    if info is None or tracks is None or not clusters:
        raise IngestionContractError("WebM Info, Tracks, and Cluster are required")
    info_fields = set()
    for element_id, start, end, _, _ in _ebml_children(content, info[1], info[2], state):
        if element_id in {_CRC32}:
            raise IngestionContractError("CRC-32 elements are not supported")
        if element_id == _VOID:
            continue
        _unique(info_fields, element_id, "WebM Info field")
        if element_id == 0x2AD7B1:
            scale = _ebml_uint(content, start, end, "WebM timecode scale")
            if not 1 <= scale <= 1_000_000_000:
                raise IngestionContractError("WebM timecode scale is invalid")
        elif element_id == 0x4489:
            _ebml_float(content, start, end, "WebM duration")
        elif element_id in {0x4D80, 0x5741}:
            _ebml_ascii(content, start, end)
        else:
            raise IngestionContractError("WebM Info contains an unsupported active element")
    track_children = _ebml_children(content, tracks[1], tracks[2], state)
    if any(item[0] not in {_TRACK_ENTRY, _VOID} for item in track_children):
        raise IngestionContractError("WebM Tracks contains an unsupported active element")
    entries = [item for item in track_children if item[0] == _TRACK_ENTRY]
    if len(entries) != 1:
        raise IngestionContractError("WebM must contain exactly one audio track")
    track_number, channels = _webm_track(content, entries[0], state)
    previous = -1
    for cluster in clusters:
        previous = _webm_cluster(content, cluster, state, track_number, previous)
    return {"trackCount": 1, "channels": channels}


def audio_original_manifest(content: bytes, filename: str, media_type: str) -> AudioOriginalManifest:
    if Path(filename).suffix.lower() != ".webm" or media_type != "audio/webm":
        raise IngestionContractError("audio original extension and media type must be .webm and audio/webm")
    inspected = inspect_webm_opus_audio(content)
    return {
        "schemaId": AUDIO_ORIGINAL_SCHEMA,
        "container": "webm",
        "codec": "opus",
        "mediaType": "audio/webm",
        "trackCount": 1,
        "channels": inspected["channels"],
        "byteSize": len(content),
        "contentSha256": sha256_bytes(content),
    }


def audio_original_candidate(filename: str, supplied: Optional[str], content: Optional[bytes] = None) -> bool:
    normalized_type = (supplied or "").split(";", 1)[0].strip().lower()
    return (Path(filename).suffix.lower() in AUDIO_VIDEO_EXTENSIONS
            or normalized_type.startswith(("audio/", "video/"))
            or bool(content and content.startswith(b"\x1a\x45\xdf\xa3")))


def normalize_audio_original_manifest(
    value: Any, *, media_type: Optional[str] = None,
    content_sha256: Optional[str] = None, byte_size: Optional[int] = None,
) -> AudioOriginalManifest:
    keys = {"schemaId", "container", "codec", "mediaType", "trackCount", "channels", "byteSize", "contentSha256"}
    if (not isinstance(value, dict) or set(value) != keys
            or value.get("schemaId") != AUDIO_ORIGINAL_SCHEMA
            or value.get("container") != "webm" or value.get("codec") != "opus"
            or value.get("mediaType") != "audio/webm" or value.get("trackCount") != 1
            or isinstance(value.get("channels"), bool) or not isinstance(value.get("channels"), int)
            or not 1 <= value["channels"] <= 2
            or isinstance(value.get("byteSize"), bool) or not isinstance(value.get("byteSize"), int)
            or not 1 <= value["byteSize"] <= MAX_AUDIO_ORIGINAL_BYTES
            or not isinstance(value.get("contentSha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["contentSha256"])):
        raise IngestionContractError("audio original manifest is invalid")
    if media_type is not None and media_type != value["mediaType"]:
        raise IngestionContractError("audio original manifest has a different media type")
    if content_sha256 is not None and content_sha256 != value["contentSha256"]:
        raise IngestionContractError("audio original manifest has a different content hash")
    if byte_size is not None and byte_size != value["byteSize"]:
        raise IngestionContractError("audio original manifest has a different byte size")
    return dict(value)


def bounded_text(value: Optional[str], name: str, maximum: int, *, required: bool = False) -> Optional[str]:
    normalized = (value or "").strip()
    if required and not normalized:
        raise IngestionContractError(f"{name} is required")
    if len(normalized) > maximum:
        raise IngestionContractError(f"{name} exceeds {maximum} characters")
    return normalized or None


def decode_import_metadata(value: Optional[str]) -> DurableImportMetadata:
    encoded = value or ""
    if not encoded or len(encoded) > MAX_IMPORT_METADATA_HEADER_CHARS or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
        raise IngestionContractError("import metadata header is invalid")
    padding = "=" * (-len(encoded) % 4)
    try:
        raw = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
        if len(raw) > MAX_IMPORT_METADATA_BYTES:
            raise IngestionContractError("import metadata exceeds 6000 UTF-8 bytes")
        decoded = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IngestionContractError("import metadata must be base64url UTF-8 JSON") from error
    if not isinstance(decoded, dict) or set(decoded) - {
        "title", "filename", "sourceKind", "sourceUri", "arxivId", "ingestionPlan",
        "captureIntentSha256",
    }:
        raise IngestionContractError("import metadata has unknown fields")
    if (
        not isinstance(decoded.get("title"), str)
        or not isinstance(decoded.get("filename"), str)
        or ("sourceKind" in decoded and not isinstance(decoded["sourceKind"], str))
        or (decoded.get("sourceUri") is not None and not isinstance(decoded["sourceUri"], str))
        or (decoded.get("arxivId") is not None and not isinstance(decoded["arxivId"], str))
        or (decoded.get("ingestionPlan") is not None and not isinstance(decoded["ingestionPlan"], dict))
        or (decoded.get("captureIntentSha256") is not None and not isinstance(decoded["captureIntentSha256"], str))
    ):
        raise IngestionContractError("import metadata fields are invalid")
    title = bounded_text(decoded.get("title"), "title", 500, required=True)
    filename = bounded_text(decoded.get("filename"), "filename", 512, required=True)
    source_kind = decoded.get("sourceKind") or "upload"
    if source_kind not in {"upload", "url", "arxiv", "legacy-paper", "datasource"}:
        raise IngestionContractError("document source kind is invalid")
    source_uri = normalize_source_uri(decoded.get("sourceUri"), source_kind=source_kind)
    if source_kind in {"url", "arxiv", "datasource"} and source_uri is None:
        raise IngestionContractError("URL, arXiv, and datasource sources require a source URI")
    arxiv_id = normalize_arxiv_id(decoded.get("arxivId"))
    capture_intent_sha256 = decoded.get("captureIntentSha256")
    if capture_intent_sha256 is not None:
        if source_kind != "url" or not re.fullmatch(r"[0-9a-f]{64}", capture_intent_sha256):
            raise IngestionContractError("capture intent digest is invalid")
    metadata = {
        "title": title,
        "filename": filename,
        "sourceKind": source_kind,
        "sourceUri": source_uri,
        "arxivId": arxiv_id,
    }
    if "ingestionPlan" in decoded:
        metadata["ingestionPlan"] = decoded.get("ingestionPlan")
    if capture_intent_sha256 is not None:
        metadata["captureIntentSha256"] = capture_intent_sha256
    return metadata


def normalize_arxiv_id(value: Optional[str]) -> Optional[str]:
    normalized = bounded_text(value, "arXiv identifier", 80)
    if normalized is None:
        return None
    normalized = re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:)", "", normalized, flags=re.I)
    normalized = re.sub(r"\.pdf$", "", normalized, flags=re.I)
    if not ARXIV_ID.fullmatch(normalized):
        raise IngestionContractError("arXiv identifier is invalid")
    return normalized


def normalize_source_uri(value: Optional[str], *, source_kind: str = "upload") -> Optional[str]:
    normalized = bounded_text(value, "source URI", 4096)
    if normalized is None:
        return None
    parsed = urlsplit(normalized)
    if parsed.scheme.lower() == "datasource":
        if (
            source_kind != "datasource"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.netloc.lower() != parsed.hostname.lower()
            or not re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                parsed.hostname,
                flags=re.I,
            )
            or not parsed.path.startswith("/")
            or parsed.path == "/"
            or parsed.query
            or parsed.fragment
        ):
            raise IngestionContractError("datasource source URI is invalid")
        return urlunsplit(("datasource", parsed.netloc.lower(), parsed.path, "", ""))
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise IngestionContractError("source URI must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise IngestionContractError("source URI cannot contain credentials")
    return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def media_type(filename: str, supplied: Optional[str]) -> str:
    value = (supplied or "").split(";", 1)[0].strip().lower()
    if value and len(value) <= 200 and re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", value):
        return value
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def normalize_display_filename(
    title: str,
    original_filename: str,
    content_sha256: str,
    arxiv_id: Optional[str] = None,
) -> str:
    """One authoritative filename rule; provenance retains the original name."""
    clean_title = unicodedata.normalize("NFKC", title).strip()
    clean_title = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", " ", clean_title)
    clean_title = re.sub(r"\s+", " ", clean_title).strip(" .") or "Untitled document"
    extension = Path(original_filename).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", extension):
        extension = ""
    normalized_arxiv = normalize_arxiv_id(arxiv_id)
    suffix = f"arXiv {normalized_arxiv}" if normalized_arxiv else content_sha256[:12]
    maximum_title = max(1, 512 - len(extension) - len(suffix) - 3)
    return f"{clean_title[:maximum_title].rstrip()} [{suffix}]{extension}"


def import_request_hash(metadata: dict, content_sha256: str) -> str:
    return sha256_bytes(canonical_json({"metadata": metadata, "contentSha256": content_sha256}).encode("utf-8"))


def transform_request_hash(
    revision_id: str,
    input_sha256: str,
    adapter_fingerprint: str = "unconfigured",
    ingestion_plan_sha256: Optional[str] = None,
    reprocess_nonce: Optional[str] = None,
) -> str:
    request_identity = {
        "pipeline": TRANSFORM_PIPELINE_VERSION,
        "configRevision": TRANSFORM_CONFIG_REVISION,
        "adapterFingerprint": adapter_fingerprint,
        "documentRevisionId": revision_id,
        "inputSha256": input_sha256,
    }
    # Preserve legacy replay identity exactly. Plan-governed revisions add the
    # immutable persisted plan digest as an explicit fence.
    if ingestion_plan_sha256 is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", ingestion_plan_sha256):
            raise IngestionContractError("ingestion plan hash is invalid")
        request_identity["ingestionPlanSha256"] = ingestion_plan_sha256
    if reprocess_nonce is not None:
        if not re.fullmatch(r"[!-~]{8,200}", reprocess_nonce):
            raise IngestionContractError("transform reprocess nonce is invalid")
        request_identity["reprocessNonce"] = reprocess_nonce
    return sha256_bytes(canonical_json(request_identity).encode("utf-8"))


def fallback_plugin_for_filename(filename: str) -> Optional[str]:
    extension = Path(filename).suffix.lower()
    if extension in MARKITDOWN_EXTENSIONS:
        return "markitdown"
    if extension in PLAIN_TEXT_EXTENSIONS:
        return "plain-text"
    return None


def normalize_markitdown_document(payload: Any) -> str:
    if not isinstance(payload, dict) or not isinstance(payload.get("markdown"), str):
        raise IngestionContractError("MarkItDown response must contain Markdown text")
    markdown = payload["markdown"]
    if len(markdown) > MAX_MARKDOWN_CHARS or len(markdown.encode("utf-8")) > MAX_TRANSFORM_OUTPUT_BYTES:
        raise IngestionContractError("MarkItDown output exceeds the transform limit")
    return markdown


def docling_response_metadata(payload: Any) -> DoclingResponseMetadata:
    if not isinstance(payload, dict) or not isinstance(payload.get("document"), dict):
        raise IngestionContractError("Docling response must contain a document object")
    status = payload.get("status")
    if status not in {"success", "partial_success"}:
        raise IngestionContractError("Docling response did not complete successfully")
    errors = payload.get("errors", [])
    if not isinstance(errors, list) or len(errors) > 10_000:
        raise IngestionContractError("Docling response errors are invalid or exceed the limit")
    return {"status": status, "errorCount": len(errors)}


def _docling_status(payload: Any) -> dict:
    docling_response_metadata(payload)
    return payload["document"]


def normalize_docling_markdown(payload: Any) -> str:
    """Extract the bounded Markdown representation returned by Docling Serve v1."""
    document = _docling_status(payload)
    markdown = document.get("md_content")
    if not isinstance(markdown, str):
        raise IngestionContractError("Docling response must contain Markdown content")
    if len(markdown) > MAX_MARKDOWN_CHARS or len(markdown.encode("utf-8")) > MAX_TRANSFORM_OUTPUT_BYTES:
        raise IngestionContractError("Docling Markdown output exceeds the transform limit")
    return markdown


def normalize_plain_text_document(filename: str, content: bytes) -> str:
    if fallback_plugin_for_filename(filename) != "plain-text":
        raise IngestionContractError("File is not a supported plain-text document")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise IngestionContractError("Plain-text document must be valid UTF-8") from error
    if len(text) > MAX_MARKDOWN_CHARS or len(content) > MAX_TRANSFORM_OUTPUT_BYTES:
        raise IngestionContractError("Plain-text output exceeds the transform limit")
    return text


def representation_content_sha256(kind: str, content: Any) -> str:
    if kind == "document-structure":
        if not isinstance(content, dict) or content.get("schemaId") != STRUCTURE_SCHEMA:
            raise IngestionContractError("Document structure representation is invalid")
        encoded = canonical_json(content).encode("utf-8")
    elif kind in {"markdown", "text"}:
        if not isinstance(content, str):
            raise IngestionContractError("Text representation is invalid")
        encoded = content.encode("utf-8")
    else:
        raise IngestionContractError("Representation kind is not hashable")
    if len(encoded) > MAX_TRANSFORM_OUTPUT_BYTES:
        raise IngestionContractError("Representation exceeds the transform limit")
    return sha256_bytes(encoded)


def _optional_dimension(value: Any) -> Optional[float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return None
    return float(value)


def _normalize_region(
    value: Any,
    *,
    page_dimensions: Optional[tuple[float, float]] = None,
    coordinate_origin: Optional[str] = None,
) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise IngestionContractError("Docling region must be an object")
    xy_keys = ("x", "y", "width", "height")
    edge_keys = ("left", "top", "right", "bottom")
    supplied_xy = any(key in value for key in xy_keys)
    supplied_edges = any(key in value for key in edge_keys)
    if supplied_xy == supplied_edges:
        raise IngestionContractError("Docling region must use one complete coordinate shape")
    keys = xy_keys if supplied_xy else edge_keys
    if not all(key in value for key in keys):
        raise IngestionContractError("Docling region coordinates are incomplete")
    region = {}
    for key in keys:
        dimension = _optional_dimension(value.get(key))
        if dimension is None:
            raise IngestionContractError("Docling region coordinates must be finite numbers")
        region[key] = dimension
    if supplied_xy:
        if region["x"] < 0 or region["y"] < 0 or region["width"] <= 0 or region["height"] <= 0:
            raise IngestionContractError("Docling region coordinates are invalid")
        if page_dimensions is not None and (
            region["x"] + region["width"] > page_dimensions[0]
            or region["y"] + region["height"] > page_dimensions[1]
        ):
            raise IngestionContractError("Docling region exceeds its page bounds")
    else:
        if (
            min(region.values()) < 0
            or region["left"] >= region["right"]
            or region["top"] == region["bottom"]
        ):
            raise IngestionContractError("Docling region coordinates are invalid")
        if page_dimensions is not None and (
            region["right"] > page_dimensions[0]
            or max(region["top"], region["bottom"]) > page_dimensions[1]
        ):
            raise IngestionContractError("Docling region exceeds its page bounds")
    if coordinate_origin is not None:
        if coordinate_origin not in {"TOPLEFT", "BOTTOMLEFT"}:
            raise IngestionContractError("Docling coordinate origin is invalid")
        region["coordOrigin"] = coordinate_origin
    return region


def _normalize_pages(value: Any) -> List[dict]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_DOCLING_PAGES:
        raise IngestionContractError("Docling pages are invalid or exceed the limit")
    pages = []
    page_numbers = set()
    for index, page in enumerate(value):
        if not isinstance(page, dict):
            raise IngestionContractError("Docling pages must be objects")
        number = page.get("number")
        if number is None:
            number = index + 1
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            raise IngestionContractError("Docling page numbers must be positive integers")
        if number in page_numbers:
            raise IngestionContractError("Docling page numbers must be unique")
        page_numbers.add(number)
        normalized = {"number": number}
        if ("width" in page) != ("height" in page):
            raise IngestionContractError("Docling page dimensions must include width and height")
        for key in ("width", "height"):
            if key in page:
                dimension = _optional_dimension(page.get(key))
                if dimension is None or dimension <= 0:
                    raise IngestionContractError("Docling page dimensions must be positive numbers")
                normalized[key] = dimension
        pages.append(normalized)
    return pages


def _official_docling_json(value: Any) -> dict:
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_TRANSFORM_OUTPUT_BYTES:
            raise IngestionContractError("Docling JSON output exceeds the transform limit")
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise IngestionContractError("Docling JSON content is invalid") from error
    if not isinstance(value, dict):
        raise IngestionContractError("Docling JSON content must be an object")
    return value


def _official_docling_pages(value: Any) -> List[dict]:
    if value is None:
        return []
    if not isinstance(value, dict) or len(value) > MAX_DOCLING_PAGES:
        raise IngestionContractError("Docling pages are invalid or exceed the limit")
    pages = []
    page_numbers = set()
    for index, (page_key, page) in enumerate(value.items()):
        if not isinstance(page, dict):
            raise IngestionContractError("Docling pages must be objects")
        number = page.get("page_no")
        if number is None:
            try:
                number = int(page_key)
            except (TypeError, ValueError):
                number = index + 1
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            raise IngestionContractError("Docling page numbers must be positive integers")
        if number in page_numbers:
            raise IngestionContractError("Docling page numbers must be unique")
        page_numbers.add(number)
        size = page.get("size") if isinstance(page.get("size"), dict) else page
        normalized = {"number": number}
        if ("width" in size) != ("height" in size):
            raise IngestionContractError("Docling page dimensions must include width and height")
        for key in ("width", "height"):
            if key in size:
                dimension = _optional_dimension(size.get(key))
                if dimension is None or dimension <= 0:
                    raise IngestionContractError("Docling page dimensions must be positive numbers")
                normalized[key] = dimension
        pages.append(normalized)
    return pages


def _docling_item_text(item: dict) -> Optional[str]:
    direct = item.get("text")
    if isinstance(direct, str) and direct.strip():
        return bounded_text(direct, "block text", 1_000_000)
    data = item.get("data")
    if isinstance(data, dict):
        cells = data.get("table_cells")
        if isinstance(cells, list):
            values = [
                cell.get("text").strip()
                for cell in cells
                if isinstance(cell, dict) and isinstance(cell.get("text"), str) and cell.get("text").strip()
            ]
            if values:
                return bounded_text(" | ".join(values), "block text", 1_000_000)
    annotations = item.get("annotations")
    if isinstance(annotations, list):
        values = []
        for annotation in annotations:
            if not isinstance(annotation, dict):
                continue
            for key in ("text", "description"):
                value = annotation.get(key)
                if isinstance(value, str) and value.strip():
                    values.append(value.strip())
                    break
        if values:
            return bounded_text("\n".join(values), "block text", 1_000_000)
    return None


def _docling_caption_text(item: dict, text_by_reference: dict[str, str]) -> Optional[str]:
    captions = item.get("captions")
    if captions is None:
        return None
    if not isinstance(captions, list) or len(captions) > 10_000:
        raise IngestionContractError("Docling picture captions are invalid or exceed the limit")
    values = []
    for caption in captions:
        reference = caption.get("$ref") if isinstance(caption, dict) else caption
        if not isinstance(reference, str):
            raise IngestionContractError("Docling picture caption reference is invalid")
        value = text_by_reference.get(reference)
        if value is None:
            raise IngestionContractError("Docling picture caption reference is unresolved")
        values.append(value)
    if not values:
        return None
    return bounded_text("\n".join(values), "block text", 1_000_000)


def _docling_item_region(
    item: dict,
    page_dimensions: dict[int, tuple[float, float]],
    declared_pages: set[int],
) -> tuple[Optional[int], Optional[dict]]:
    provenance = item.get("prov")
    if provenance is None:
        return None, None
    if not isinstance(provenance, list) or not provenance or not isinstance(provenance[0], dict):
        raise IngestionContractError("Docling block provenance is invalid")
    first = provenance[0]
    page = first.get("page_no")
    if not isinstance(page, int) or isinstance(page, bool) or page <= 0:
        raise IngestionContractError("Docling block page must be a positive integer")
    if page not in declared_pages:
        raise IngestionContractError("Docling block page is not declared")
    bbox = first.get("bbox")
    if bbox is None:
        return page, None
    if not isinstance(bbox, dict):
        raise IngestionContractError("Docling bounding box is invalid")
    origin = bbox.get("coord_origin")
    if not isinstance(origin, str):
        raise IngestionContractError("Docling bounding box coordinate origin is required")
    region = _normalize_region({
        "left": bbox.get("l"),
        "top": bbox.get("t"),
        "right": bbox.get("r"),
        "bottom": bbox.get("b"),
    }, page_dimensions=page_dimensions.get(page), coordinate_origin=origin.upper())
    return page, region


def _docling_block_id(item: dict, category: str, index: int) -> tuple[str, Optional[str]]:
    reference = item.get("self_ref")
    if isinstance(reference, str) and reference.strip():
        reference = reference.strip()
        if len(reference) <= 128:
            return reference, reference
        return f"docling-{sha256_bytes(reference.encode('utf-8'))[:24]}", reference
    return f"{category}-{index}", None


def _normalize_official_docling(document: dict) -> GalaxyDocumentStructure:
    content = _official_docling_json(document.get("json_content"))
    pages = _official_docling_pages(content.get("pages"))
    declared_pages = {page["number"] for page in pages}
    page_dimensions = {
        page["number"]: (page["width"], page["height"])
        for page in pages if "width" in page and "height" in page
    }
    categories = ("texts", "tables", "pictures", "key_value_items")
    raw_texts = content.get("texts", [])
    if not isinstance(raw_texts, list):
        raise IngestionContractError("Docling texts must be a list")
    text_by_reference = {}
    for item in raw_texts:
        if not isinstance(item, dict):
            raise IngestionContractError("Docling document items must be objects")
        reference = item.get("self_ref")
        value = _docling_item_text(item)
        if isinstance(reference, str) and value is not None:
            text_by_reference[reference] = value
    normalized = []
    block_ids = set()
    reference_to_id = {}
    for category in categories:
        items = content.get(category, [])
        if not isinstance(items, list):
            raise IngestionContractError(f"Docling {category} must be a list")
        if len(items) > 100_000 or len(normalized) + len(items) > 100_000:
            raise IngestionContractError("Docling document blocks exceed the limit")
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise IngestionContractError("Docling document items must be objects")
            kind_value = item.get("label") or category.removesuffix("s")
            if not isinstance(kind_value, str):
                raise IngestionContractError("Docling item label must be text")
            kind = bounded_text(kind_value, "block kind", 80, required=True)
            text = _docling_item_text(item)
            if text is None and kind.casefold() in {"picture", "figure"}:
                text = _docling_caption_text(item, text_by_reference)
            explicit_latex = item.get("latex")
            if explicit_latex is not None and not isinstance(explicit_latex, str):
                raise IngestionContractError("Docling block LaTeX must be text")
            latex = bounded_text(explicit_latex, "block LaTeX", 1_000_000)
            if latex is None and kind.casefold() in {"formula", "equation"}:
                if text is None:
                    original = item.get("orig")
                    if original is not None and not isinstance(original, str):
                        raise IngestionContractError("Docling formula original must be text")
                    text = bounded_text(original, "block LaTeX", 1_000_000)
                latex = text
                text = None
            # Preserve addressable figures when Docling supplied caption evidence;
            # image bytes remain excluded from the canonical structure projection.
            if text is None and latex is None:
                continue
            block_id, reference = _docling_block_id(item, category, index)
            if block_id in block_ids:
                raise IngestionContractError("Docling block identifiers must be unique")
            block_ids.add(block_id)
            if reference is not None:
                reference_to_id[reference] = block_id
            page, region = _docling_item_region(item, page_dimensions, declared_pages)
            normalized.append({
                "id": block_id,
                "kind": kind,
                "order": len(normalized),
                "text": text,
                "latex": latex,
                "page": page,
                "region": region,
            })

    group_by_reference = {}
    groups = content.get("groups", [])
    if not isinstance(groups, list) or len(groups) > 100_000:
        raise IngestionContractError("Docling groups are invalid or exceed the limit")
    for group in groups:
        if isinstance(group, dict) and isinstance(group.get("self_ref"), str):
            group_by_reference[group["self_ref"]] = group

    reading_order = []
    seen_blocks = set()
    seen_groups = set()

    # Converter-authored group graphs may be deeply nested. Traverse them with
    # an explicit bounded stack so a valid-sized document cannot exhaust the
    # Python call stack or escape the durable terminal-receipt path.
    stack = [content.get("body")]
    visited_nodes = 0
    while stack:
        node = stack.pop()
        visited_nodes += 1
        if visited_nodes > 200_000:
            raise IngestionContractError("Docling reading-order graph exceeds the limit")
        if not isinstance(node, dict):
            continue
        reference = node.get("$ref")
        if isinstance(reference, str):
            block_id = reference_to_id.get(reference)
            if block_id is not None and block_id not in seen_blocks:
                seen_blocks.add(block_id)
                reading_order.append(block_id)
                continue
            group = group_by_reference.get(reference)
            if group is not None and reference not in seen_groups:
                seen_groups.add(reference)
                children = group.get("children")
                if isinstance(children, list):
                    stack.extend(reversed(children))
            continue
        children = node.get("children")
        if isinstance(children, list):
            stack.extend(reversed(children))
    for block in normalized:
        if block["id"] not in seen_blocks:
            reading_order.append(block["id"])
    result = {
        "schemaId": STRUCTURE_SCHEMA,
        "pages": pages,
        "blocks": normalized,
        "readingOrder": reading_order,
    }
    representation_content_sha256("document-structure", result)
    return result


def normalize_docling_document(payload: Any) -> GalaxyDocumentStructure:
    """Normalize official Docling Serve v1 and the legacy private connector shape."""
    document = _docling_status(payload)
    if "json_content" in document:
        return _normalize_official_docling(document)
    blocks = document.get("blocks")
    if not isinstance(blocks, list) or len(blocks) > 100_000:
        raise IngestionContractError("Docling document blocks are invalid or exceed the limit")
    pages = _normalize_pages(document.get("pages"))
    declared_pages = {page["number"] for page in pages}
    page_dimensions = {
        page["number"]: (page["width"], page["height"])
        for page in pages if "width" in page and "height" in page
    }
    normalized = []
    block_ids = set()
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise IngestionContractError("Docling blocks must be objects")
        kind = bounded_text(block.get("kind"), "block kind", 80, required=True)
        text = bounded_text(block.get("text"), "block text", 1_000_000)
        latex = bounded_text(block.get("latex"), "block LaTeX", 1_000_000)
        if text is None and latex is None:
            raise IngestionContractError("Docling block must contain text or LaTeX")
        block_id = bounded_text(block.get("id"), "block id", 128) or f"block-{index}"
        if block_id in block_ids:
            raise IngestionContractError("Docling block identifiers must be unique")
        block_ids.add(block_id)
        page = block.get("page")
        if page is not None:
            if not isinstance(page, int) or isinstance(page, bool) or page <= 0:
                raise IngestionContractError("Docling block page must be a positive integer")
            if page not in declared_pages:
                raise IngestionContractError("Docling block page is not declared")
        if block.get("region") is not None and page is None:
            raise IngestionContractError("Docling region requires a declared block page")
        normalized.append({
            "id": block_id,
            "kind": kind,
            "order": index,
            "text": text,
            "latex": latex,
            "page": page,
            "region": _normalize_region(
                block.get("region"), page_dimensions=page_dimensions.get(page),
            ),
        })
    result = {
        "schemaId": STRUCTURE_SCHEMA,
        "pages": pages,
        "blocks": normalized,
        "readingOrder": [block["id"] for block in normalized],
    }
    representation_content_sha256("document-structure", result)
    return result

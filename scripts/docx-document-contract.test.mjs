import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DOCX_MEDIA_TYPE,
  DocxDocumentContractError,
  MAX_DOCX_BYTES,
  validateDocxPackageMetadata,
} from "../lib/docx-document-contract.js"
import { planAtlasFileImport, preflightAtlasDropImport } from "../lib/atlas-drop-import.js"
import { prepareDurableDocumentImport } from "../lib/durable-document-import.js"

const encoder = new TextEncoder()
const required = {
  "[Content_Types].xml": "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
  "_rels/.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
  "word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p/></w:body></w:document>",
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value) {
  const out = Buffer.alloc(2)
  out.writeUInt16LE(value)
  return out
}

function u32(value) {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

function zipFixture(parts = required, options = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(typeof content === "string" ? encoder.encode(content) : content)
    const localExtra = Buffer.from(options.localExtra?.[name] ?? options.extra?.[name] ?? [])
    const centralExtra = Buffer.from(options.centralExtra?.[name] ?? options.extra?.[name] ?? [])
    const flags = options.flags?.[name] ?? 0x0800
    const attributes = options.attributes?.[name] ?? 0
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(0), u16(0), u16(0),
      u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(localExtra.length), nameBytes, localExtra, data,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(options.madeBy?.[name] ?? 20), u16(20), u16(flags), u16(0), u16(0), u16(0),
      u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(centralExtra.length), u16(0),
      u16(0), u16(0), u32(attributes), u32(offset), nameBytes, centralExtra,
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const body = Buffer.concat(locals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(body.length), u16(0),
  ])
  return Uint8Array.from(Buffer.concat([body, central, eocd])).buffer
}

function withZipPrefix(buffer, prefix) {
  const body = Buffer.from(buffer.slice(0))
  const eocd = body.length - 22
  const centralOffset = body.readUInt32LE(eocd + 16)
  const entryCount = body.readUInt16LE(eocd + 10)
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    body.writeUInt32LE(body.readUInt32LE(cursor + 42) + prefix.length, cursor + 42)
    cursor += 46 + body.readUInt16LE(cursor + 28) + body.readUInt16LE(cursor + 30) + body.readUInt16LE(cursor + 32)
  }
  body.writeUInt32LE(centralOffset + prefix.length, eocd + 16)
  return Uint8Array.from(Buffer.concat([prefix, body])).buffer
}

function withZipGap(buffer, gap) {
  const body = Buffer.from(buffer.slice(0))
  const eocd = body.length - 22
  const centralOffset = body.readUInt32LE(eocd + 16)
  const combined = Buffer.concat([body.subarray(0, centralOffset), gap, body.subarray(centralOffset)])
  combined.writeUInt32LE(centralOffset + gap.length, eocd + gap.length + 16)
  return Uint8Array.from(combined).buffer
}

test("strict DOCX metadata preflight accepts canonical or empty browser MIME and preserves exact bytes", async () => {
  const bytes = zipFixture()
  assert.equal(validateDocxPackageMetadata("paper.docx", "", bytes).mediaType, DOCX_MEDIA_TYPE)
  assert.equal(validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, bytes).entryCount, 3)
  const file = {
    name: "paper.docx", type: "", size: bytes.byteLength,
    async arrayBuffer() { return bytes.slice(0) },
  }
  const prepared = await prepareDurableDocumentImport(file, {
    title: "Exact paper", filename: file.name, sourceKind: "upload", sourceUri: null, arxivId: null,
  })
  assert.equal(prepared.mediaType, DOCX_MEDIA_TYPE)
  assert.deepEqual(new Uint8Array(prepared.bytes), new Uint8Array(bytes))
  const atlasFile = new File([bytes], "paper.docx", { type: "" })
  const plan = planAtlasFileImport(atlasFile)
  assert.equal(plan.mediaType, DOCX_MEDIA_TYPE)
  assert.equal((await preflightAtlasDropImport(plan)).filename, "paper.docx")
})

test("DOCX preflight rejects renamed ZIPs, required-part gaps, unsafe names, active content, and MIME mismatch", () => {
  const cases = [
    ["paper.zip", DOCX_MEDIA_TYPE, zipFixture()],
    ["paper.docx", "application/zip", zipFixture()],
    ["paper.docx", DOCX_MEDIA_TYPE, zipFixture({ "random.txt": "not OOXML" })],
    ["paper.docx", DOCX_MEDIA_TYPE, zipFixture({ ...required, "../escape.xml": "escape" })],
    ["paper.docx", DOCX_MEDIA_TYPE, zipFixture({ ...required, "word/vbaProject.bin": "macro" })],
    ["paper.docx", DOCX_MEDIA_TYPE, zipFixture({ ...required, "word/embeddings/object.bin": "ole" })],
  ]
  for (const [name, mediaType, bytes] of cases) {
    assert.throws(() => validateDocxPackageMetadata(name, mediaType, bytes), DocxDocumentContractError)
  }
})

test("DOCX ZIP metadata rejects encryption, symlinks, collisions, ZIP64, corrupt local headers, and the raw cap", () => {
  const encrypted = zipFixture(required, { flags: { "word/document.xml": 0x0801 } })
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, encrypted), /valid non-macro DOCX/u)

  const symlink = zipFixture({ ...required, "word/link.xml": "target" }, {
    madeBy: { "word/link.xml": 0x0314 },
    attributes: { "word/link.xml": 0xa1ff0000 },
  })
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, symlink), DocxDocumentContractError)

  const collision = zipFixture({ ...required, "WORD/document.xml": "collision" })
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, collision), DocxDocumentContractError)

  const printerSettings = zipFixture({ ...required, "word/printerSettings/printerSettings1.bin": "settings" })
  assert.equal(validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, printerSettings).entryCount, 4)

  const zip64 = new Uint8Array(zipFixture())
  const eocd = zip64.byteLength - 22
  new DataView(zip64.buffer).setUint16(eocd + 10, 0xffff, true)
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, zip64.buffer), DocxDocumentContractError)

  const zip64Extra = zipFixture(required, { extra: { "word/document.xml": [1, 0, 0, 0] } })
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, zip64Extra), DocxDocumentContractError)

  const localZip64Extra = zipFixture(required, { localExtra: { "word/document.xml": [1, 0, 0, 0] } })
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, localZip64Extra), DocxDocumentContractError)

  const mismatchedLocal = new Uint8Array(zipFixture())
  new DataView(mismatchedLocal.buffer).setUint16(6, 0x0801, true)
  assert.throws(() => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, mismatchedLocal.buffer), DocxDocumentContractError)

  assert.throws(
    () => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, withZipPrefix(zipFixture(), Buffer.alloc(64, 0x4d))),
    DocxDocumentContractError,
  )
  assert.throws(
    () => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, withZipGap(zipFixture(), Buffer.from("opaque"))),
    DocxDocumentContractError,
  )

  assert.throws(
    () => validateDocxPackageMetadata("paper.docx", DOCX_MEDIA_TYPE, new ArrayBuffer(MAX_DOCX_BYTES + 1)),
    /25 MiB/u,
  )
})

test("authoritative DOCX validation is bounded and precedes the durable persistence call", async () => {
  const [server, contract] = await Promise.all([
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/durable_ingestion.py", import.meta.url), "utf8"),
  ])
  const route = server.slice(server.indexOf("async def import_document("), server.indexOf("async def get_document("))
  assert.ok(route.indexOf("validate_docx_package") > -1)
  assert.ok(route.indexOf("validate_docx_package") < route.indexOf("_persist_document_import("))
  assert.match(route, /docx_upload and declared_bytes > MAX_DOCX_BYTES/u)
  assert.match(route, /docx_upload and len\(content\) \+ len\(chunk\) > MAX_DOCX_BYTES/u)
  assert.match(contract, /archive\.open\(entry, "r"\)/u)
  assert.doesNotMatch(contract, /extract(?:all)?\(/u)
})

test("DOCX raw-size rejection is specific and occurs before reading bytes", async () => {
  let read = false
  const file = {
    name: "oversized.docx", type: DOCX_MEDIA_TYPE, size: MAX_DOCX_BYTES + 1,
    async arrayBuffer() { read = true; return new ArrayBuffer(0) },
  }
  await assert.rejects(
    prepareDurableDocumentImport(file, {
      title: "Oversized", filename: file.name, sourceKind: "upload", sourceUri: null, arxivId: null,
    }),
    /DOCX file no larger than 25 MiB/u,
  )
  assert.equal(read, false)
})

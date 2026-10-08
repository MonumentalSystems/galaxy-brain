import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import sharp from "sharp"

import {
  authorizeAtlasDropImportTarget,
  atlasDropImportRegistered,
  AtlasDropImportError,
  atlasDropTitle,
  atlasDropWorldPoint,
  commitAtlasDropCallbacks,
  createAtlasDropImportOwner,
  planAtlasDropImport,
  planAtlasFileImport,
  preflightAtlasDropImport,
} from "../lib/atlas-drop-import.js"
import {
  durableUploadMediaType,
  prepareDurableDocumentImport,
} from "../lib/durable-document-import.js"
import { builtinPluginRegistry } from "../lib/plugins/builtins.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

function transfer(files = [], { items = files.map((file) => ({ kind: "file", type: file.type })), types = files.length ? ["Files"] : [] } = {}) {
  return { files, items, types }
}

function file(name, type = "", bytes = "exact bytes") {
  const content = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  return new File([content], name, { type, lastModified: 1_700_000_000_000 })
}

function pdfFixture({
  xrefWhitespace = "\n",
  fieldWhitespace = " ",
  lineWhitespace = "\n",
  tailWhitespace = "\n",
  trailingWhitespace = "\n",
} = {}) {
  const beforeXref = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
  const xrefOffset = new TextEncoder().encode(beforeXref).byteLength
  return new TextEncoder().encode(`${beforeXref}xref${xrefWhitespace}0${fieldWhitespace}2${lineWhitespace}0000000000${fieldWhitespace}65535${fieldWhitespace}f${lineWhitespace}0000000009${fieldWhitespace}00000${fieldWhitespace}n${lineWhitespace}trailer${lineWhitespace}<< /Root 1 0 R /Size 2 >>${lineWhitespace}startxref${tailWhitespace}${xrefOffset}${tailWhitespace}%%EOF${trailingWhitespace}`)
}

function pdfXrefStreamFixture() {
  const beforeXref = "%PDF-1.7\n"
  const xrefOffset = new TextEncoder().encode(beforeXref).byteLength
  return new TextEncoder().encode(`${beforeXref}1\f \t0\r obj\n<< /Type\f/XRef /W\t[1 2 1] /Size 1 /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\0\f${xrefOffset}\r\n%%EOF\f`)
}

function gifFixture(version) {
  return new Uint8Array([
    ...new TextEncoder().encode(version),
    1, 0, 1, 0, 0x80, 0, 0,
    0, 0, 0, 0xff, 0xff, 0xff,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0,
    2, 2, 0x44, 1, 0, 0x3b,
  ])
}

function rtfFixture() {
  return new TextEncoder().encode("{\\rtf1\\ansi Real rich text}")
}

function ftypFixture() {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, bytes.byteLength, false)
  bytes.set(new TextEncoder().encode("ftypisom"), 4)
  bytes.set(new TextEncoder().encode("isommp42"), 16)
  return bytes
}

function tarFixture() {
  const bytes = new Uint8Array(1536)
  const write = (value, offset) => bytes.set(new TextEncoder().encode(value), offset)
  write("file.txt", 0)
  write("0000644\0", 100)
  write("0000000\0", 108)
  write("0000000\0", 116)
  write("00000000000\0", 124)
  write("00000000000\0", 136)
  write("        ", 148)
  write("0", 156)
  write("ustar\0", 257)
  write("00", 263)
  let checksum = 0
  for (let index = 0; index < 512; index += 1) checksum += bytes[index]
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
  return bytes
}

function bmpFixture() {
  const bytes = new Uint8Array(64)
  bytes.set(new TextEncoder().encode("BM"))
  const view = new DataView(bytes.buffer)
  view.setUint32(2, bytes.byteLength, true)
  view.setUint32(10, 26, true)
  view.setUint32(14, 12, true)
  return bytes
}

function formFixture() {
  const bytes = new Uint8Array(20)
  bytes.set(new TextEncoder().encode("FORM"))
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, false)
  bytes.set(new TextEncoder().encode("AIFF"), 8)
  return bytes
}

function mzFixture() {
  const bytes = new Uint8Array(128)
  bytes.set(new TextEncoder().encode("MZ"))
  new DataView(bytes.buffer).setUint32(0x3c, 64, true)
  bytes.set(new Uint8Array([0x50, 0x45, 0, 0]), 64)
  return bytes
}

function riffFixture() {
  const bytes = new Uint8Array(12)
  bytes.set(new TextEncoder().encode("RIFF"))
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true)
  bytes.set(new TextEncoder().encode("WAVE"), 8)
  return bytes
}

function id3Fixture() {
  const bytes = new Uint8Array(11)
  bytes.set(new TextEncoder().encode("ID3"))
  bytes[3] = 4
  bytes[9] = 1
  bytes[10] = 0x41
  return bytes
}

function flacFixture() {
  const bytes = new Uint8Array(42)
  bytes.set(new TextEncoder().encode("fLaC"))
  bytes[4] = 0x80
  bytes[7] = 34
  return bytes
}

function oggFixture() {
  const bytes = new Uint8Array(28)
  bytes.set(new TextEncoder().encode("OggS"))
  bytes[26] = 1
  bytes[27] = 0
  return bytes
}

function midiFixture() {
  const bytes = new Uint8Array(14)
  bytes.set(new TextEncoder().encode("MThd"))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 6, false)
  view.setUint16(8, 0, false)
  view.setUint16(10, 1, false)
  view.setUint16(12, 96, false)
  return bytes
}

function bzipFixture() {
  const bytes = new Uint8Array(10)
  bytes.set(new TextEncoder().encode("BZh9"))
  bytes.set(new Uint8Array([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]), 4)
  return bytes
}

function woffFixture(signature) {
  const headerLength = signature === "wOFF" ? 44 : 48
  const bytes = new Uint8Array(signature === "wOFF" ? 68 : 65)
  bytes.set(new TextEncoder().encode(signature))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 0x00010000, false)
  view.setUint32(8, bytes.byteLength, false)
  view.setUint16(12, 1, false)
  view.setUint32(16, 32, false)
  if (signature === "wOFF") {
    bytes.set(new TextEncoder().encode("cmap"), headerLength)
    view.setUint32(headerLength + 4, 64, false)
    view.setUint32(headerLength + 8, 4, false)
    view.setUint32(headerLength + 12, 4, false)
    bytes.set(new TextEncoder().encode("data"), 64)
  } else {
    view.setUint32(20, 16, false)
  }
  return bytes
}

function ottoFixture() {
  const bytes = new Uint8Array(32)
  bytes.set(new TextEncoder().encode("OTTO"))
  const view = new DataView(bytes.buffer)
  view.setUint16(4, 1, false)
  view.setUint16(6, 16, false)
  bytes.set(new TextEncoder().encode("CFF "), 12)
  view.setUint32(20, 28, false)
  view.setUint32(24, 4, false)
  bytes.set(new TextEncoder().encode("data"), 28)
  return bytes
}

function printableSignatureFixtures() {
  return [
    ["renamed-riff.txt", riffFixture()],
    ["renamed-id3.txt", id3Fixture()],
    ["renamed-flac.txt", flacFixture()],
    ["renamed-ogg.txt", oggFixture()],
    ["renamed-midi.txt", midiFixture()],
    ["renamed-bzip.txt", bzipFixture()],
    ["renamed-woff.txt", woffFixture("wOFF")],
    ["renamed-woff2.txt", woffFixture("wOF2")],
    ["renamed-otto.txt", ottoFixture()],
  ]
}

test("drop planner accepts one closed local file, infers empty Windows MIME, and preserves exact bytes", async () => {
  const cases = [
    ["paper.pdf", "", pdfFixture(), "application/pdf"],
    ["notes.md", "", "# Exact", "text/markdown"],
    ["model.ts", "", "export const n = 1", "text/plain"],
    ["data.json", "application/json", "{\"n\":1}", "application/json"],
    ["table.csv", "", "a,b\n1,2", "text/csv"],
    ["config.yaml", "application/x-yaml", "a: 1", "text/yaml"],
    ["config.toml", "", "a = 1", "text/x-toml"],
    ["layout.xml", "text/xml", "<a/>", "application/xml"],
  ]
  for (const [name, type, content, expectedType] of cases) {
    const original = file(name, type, content)
    const plan = planAtlasDropImport(transfer([original]))
    assert.equal(plan.filename, name)
    assert.equal(plan.mediaType, expectedType)
    assert.equal(plan.file.type, expectedType)
    const expectedBytes = typeof content === "string" ? new TextEncoder().encode(content) : content
    assert.deepEqual(new Uint8Array(await plan.file.arrayBuffer()), expectedBytes)
  }
  assert.equal(atlasDropTitle("proof_frontier-v2.md"), "proof frontier v2")
})

test("keyboard file planning shares the exact drop allowlist and canonical media normalization", () => {
  const markdown = file("field-note.md", "", "# Field note")
  const planned = planAtlasFileImport(markdown)
  assert.equal(planned.filename, "field-note.md")
  assert.equal(planned.mediaType, "text/markdown")
  assert.equal(planned.file.type, "text/markdown")
  assert.equal(planned.title, "field note")
  assert.throws(() => planAtlasFileImport(file("payload.exe", "application/octet-stream")), (error) => (
    error instanceof AtlasDropImportError && error.code === "unsupported_file_type"
  ))
})

test("unsupported, multiple, mixed, URL, directory, empty, and oversized drops fail stably before upload", () => {
  const cases = [
    [transfer([]), "no_file"],
    [transfer([], { items: [{ kind: "string", type: "text/uri-list" }], types: ["text/uri-list"] }), "url_not_supported"],
    [transfer([file("a.txt"), file("b.txt")]), "multiple_files"],
    [transfer([file("a.txt")], { items: [{ kind: "file" }, { kind: "string", type: "text/plain" }] }), "mixed_payload"],
    [transfer([file("linked.txt")], { items: [{ kind: "file", type: "text/plain" }], types: ["Files", "text/uri-list"] }), "mixed_payload"],
    [transfer([file("annotated.txt")], { items: [{ kind: "file", type: "text/plain" }], types: ["Files", "text/plain"] }), "mixed_payload"],
    [transfer([], { items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }], types: ["Files"] }), "directory_not_supported"],
    [transfer([file("vector.svg", "image/svg+xml", "<svg/>")]), "unsupported_file_type"],
    [transfer([file("audio.wav", "audio/wav")]), "unsupported_file_type"],
    [transfer([file("movie.mp4", "video/mp4")]), "unsupported_file_type"],
    [transfer([file("wrong.json", "image/png")]), "unsupported_file_type"],
    [transfer([new File([], "empty.txt", { type: "text/plain" })]), "empty_file"],
    [transfer([{ name: "large.txt", type: "text/plain", size: 100_000_001, lastModified: 0 }]), "file_too_large"],
    [transfer([{ name: "large.png", type: "image/png", size: (20 * 1024 * 1024) + 1, lastModified: 0 }]), "file_too_large"],
    [transfer([{ name: "large.webm", type: "audio/webm", size: (20 * 1024 * 1024) + 1, lastModified: 0 }]), "file_too_large"],
  ]
  let writes = 0
  for (const [payload, code] of cases) {
    assert.throws(() => {
      const plan = planAtlasDropImport(payload)
      writes += 1
      return plan
    }, (error) => error instanceof AtlasDropImportError && error.code === code)
  }
  assert.equal(writes, 0)
})

test("static raster drops preserve canonical type and pass local preflight", async () => {
  const cases = [
    ["png", "figure.png", "image/png"],
    ["jpeg", "figure.jpeg", "image/jpeg"],
    ["webp", "figure.webp", "image/webp"],
    ["gif", "figure.gif", "image/gif"],
  ]
  for (const [format, name, mediaType] of cases) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#205080ff" },
    })[format]().toBuffer()
    const plan = planAtlasDropImport(transfer([file(name, mediaType, bytes)]))
    assert.equal(plan.mediaType, mediaType)
    assert.equal(plan.file.type, mediaType)
    assert.equal(await preflightAtlasDropImport(plan), plan)
  }
})

test("WebM Opus drop passes the existing import and placement preflight without changing bytes", async () => {
  const bytes = webmOpusFixture()
  const original = file("field-recording.webm", "audio/webm", bytes)
  const plan = planAtlasDropImport(transfer([original]))
  assert.equal(plan.mediaType, "audio/webm")
  assert.equal(plan.file, original)
  assert.equal(plan.title, "field recording")
  assert.equal(await preflightAtlasDropImport(plan), plan)
  const prepared = await prepareDurableDocumentImport(plan.file, {
    title: plan.title, filename: plan.filename, sourceKind: "upload",
  })
  assert.equal(prepared.mediaType, "audio/webm")
  assert.deepEqual(new Uint8Array(prepared.bytes), bytes)
})

test("drop coordinates use the current pan and zoom and reject out-of-bounds world points", () => {
  assert.deepEqual(
    atlasDropWorldPoint({ x: 310, y: 220 }, { left: 10, top: 20 }, { x: -50, y: 75, z: 2 }),
    { x: 100, y: 175 },
  )
  assert.throws(
    () => atlasDropWorldPoint({ x: 30_000_000, y: 0 }, { left: 0, top: 0 }, { x: 0, y: 0, z: 1 }),
    /canvas bounds/u,
  )
})

test("document upload source registration is exact and fails closed on absence or descriptor mismatch", () => {
  assert.equal(atlasDropImportRegistered(builtinPluginRegistry), true)
  assert.equal(atlasDropImportRegistered({ resolve: () => null }), false)
  assert.equal(atlasDropImportRegistered({
    resolve: (kind) => kind === "sources"
      ? { pluginId: "documents", id: "document.upload", handler: { kind: "sources", implementationId: "builtin.document.upload-source" } }
      : null,
  }), false)
  assert.equal(atlasDropImportRegistered({
    resolve: () => ({ pluginId: "documents", id: "document.upload", handler: { kind: "sources", implementationId: "https://evil.test/import" } }),
  }), false)
})

test("same file and deterministic title retain the import and placement operation identity", async () => {
  const firstPlan = planAtlasDropImport(transfer([file("same_file.md", "", "# Immutable")]))
  const secondPlan = planAtlasDropImport(transfer([file("same_file.md", "", "# Immutable")]))
  const metadata = (plan) => ({
    title: plan.title,
    filename: plan.filename,
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  })
  const first = await prepareDurableDocumentImport(firstPlan.file, metadata(firstPlan))
  const second = await prepareDurableDocumentImport(secondPlan.file, metadata(secondPlan))
  assert.equal(first.idempotencyKey, second.idempotencyKey)
  assert.equal(first.placementOperationId, second.placementOperationId)
  assert.deepEqual(new Uint8Array(first.bytes), new Uint8Array(second.bytes))
})

test("invalid UTF-8 and renamed PDFs fail during local preparation before transport", async () => {
  const invalidText = planAtlasDropImport(transfer([
    new File([new Uint8Array([0xc3, 0x28])], "broken.txt", { type: "" }),
  ]))
  const renamedPdf = planAtlasDropImport(transfer([file("renamed.pdf", "", "not a pdf")]))
  const metadata = (plan) => ({
    title: plan.title,
    filename: plan.filename,
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  })
  await assert.rejects(prepareDurableDocumentImport(invalidText.file, metadata(invalidText)), /valid UTF-8/u)
  await assert.rejects(prepareDurableDocumentImport(renamedPdf.file, metadata(renamedPdf)), /valid PDF/u)
})

test("PDF validation accepts legal xref whitespace and xref-stream object headers but rejects shaped prose", () => {
  const compatible = [
    pdfFixture({ xrefWhitespace: " \n" }),
    pdfFixture({
      xrefWhitespace: "\0\t\f\r\n",
      fieldWhitespace: "\t\f",
      lineWhitespace: "\r\n",
      tailWhitespace: "\0\f\r\n",
      trailingWhitespace: "\0\t\f\r\n",
    }),
    pdfXrefStreamFixture(),
  ]
  for (const bytes of compatible) {
    assert.equal(
      durableUploadMediaType({ name: "compatible.pdf", type: "application/pdf" }, bytes.buffer),
      "application/pdf",
    )
  }

  const beforeXref = "%PDF-1.7\n"
  const xrefOffset = new TextEncoder().encode(beforeXref).byteLength
  const fake = (candidate) => new TextEncoder().encode(`${beforeXref}${candidate}\nstartxref\n${xrefOffset}\n%%EOF\n`).buffer
  for (const bytes of [
    fake("xref prose rather than a subsection"),
    fake("xref\n0 1\nnot-a-fixed-width-entry"),
    fake("1 0 obj\n<< /Type /Catalog /W [1 2 1] >>\nendobj"),
    fake("1\t0\fobj\n<< /Type /XRef /Size 1 >>\nendobj"),
  ]) {
    assert.throws(
      () => durableUploadMediaType({ name: "fake.pdf", type: "application/pdf" }, bytes),
      /valid PDF/u,
    )
  }
})

test("text preflight rejects renamed PDF, image, audio, rich, archive, executable, and binary bytes before writes", async () => {
  const binaryCases = [
    ["renamed-pdf.txt", pdfFixture()],
    ["renamed-pdf-whitespace.txt", pdfFixture({ xrefWhitespace: " \n", fieldWhitespace: "\t" })],
    ["renamed-pdf-xref-stream.txt", pdfXrefStreamFixture()],
    ["renamed-gif87a.txt", gifFixture("GIF87a")],
    ["renamed-gif89a.txt", gifFixture("GIF89a")],
    ["renamed-rtf.txt", rtfFixture()],
    ["renamed-mp4.txt", ftypFixture()],
    ["renamed-tar.txt", tarFixture()],
    ["renamed-image.txt", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["renamed-rich.txt", new TextEncoder().encode("{\\rtf1\\ansi rich text}")],
    ["renamed-archive.txt", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
    ["renamed-bitmap.txt", bmpFixture()],
    ["renamed-form.txt", formFixture()],
    ["renamed-executable.txt", mzFixture()],
    ["renamed-binary.txt", new Uint8Array([0x61, 0x00, 0x62])],
    ...printableSignatureFixtures(),
  ]
  let writes = 0
  for (const [name, bytes] of binaryCases) {
    const plan = planAtlasDropImport(transfer([new File([bytes], name, { type: "text/plain" })]))
    await assert.rejects(
      authorizeAtlasDropImportTarget(plan, async () => {
        writes += 1
        return { canvasId: "canvas-1", workspaceId: "workspace-1" }
      }),
      (error) => error instanceof AtlasDropImportError && error.code === "unsupported_file_type",
    )
  }
  assert.equal(writes, 0)

  const validCases = [
    file("valid.ts", "text/plain", "const x = 1\n\treturn x"),
    file("pdf-notes.txt", "text/plain", "The PDF header token is %PDF-1.7 when it begins the file."),
    file("pdf-prefix.txt", "text/plain", "%PDF-1.7\nThis is valid UTF-8 prose without a PDF cross-reference and EOF structure."),
    file("gif87a-prefix.txt", "text/plain", "GIF87a begins ordinary valid prose without a logical screen descriptor or image blocks."),
    file("gif89a-prefix.ts", "text/plain", "GIF89a = 'ordinary source code without a GIF data stream or trailer'"),
    file("rtf-prefix.txt", "text/plain", "{\\rtf is an ordinary literal here, without an RTF versioned root group}"),
    file("ftyp-offset.txt", "text/plain", "0000ftyp is an ordinary token at byte offset four without an ISO BMFF box length or brand."),
    file("ustar-offset.txt", "text/plain", `${"a".repeat(257)}ustar is ordinary text at byte offset 257 without a TAR header checksum.${"b".repeat(1400)}`),
    file("bitmap-notes.txt", "text/plain", "BM is a common abbreviation in valid prose and source comments."),
    file("form-example.txt", "text/plain", "FORM values may begin an ordinary text record without making it an IFF file."),
    file("mz-example.ts", "text/plain", "MZ = 'ordinary source text that is not a DOS executable, even when the source record is longer than a DOS header'"),
    file("riff-example.txt", "text/plain", "RIFF is an ordinary word in prose when no valid RIFF size and type header follows it."),
    file("id3-example.ts", "text/plain", "ID3 = 'ordinary source text, with no supported ID3 version or sync-safe length header'"),
    file("flac-example.txt", "text/plain", "fLaC may begin case-sensitive text without a STREAMINFO metadata block."),
    file("ogg-example.txt", "text/plain", "OggS may begin a note without an Ogg page version, segment table, or payload."),
    file("midi-example.ts", "text/plain", "MThd = 'ordinary code text without the six-byte MIDI header chunk contract'"),
    file("bzip-example.txt", "text/plain", "BZh starts this valid UTF-8 sentence but is not followed by a bzip block header."),
    file("woff-example.txt", "text/plain", "wOFF begins this valid source note without a declared Web Open Font length or table directory."),
    file("woff2-example.txt", "text/plain", "wOF2 begins this valid source note without a declared WOFF2 length or compressed payload."),
    file("otto-example.ts", "text/plain", "OTTO = 'ordinary source text without a bounded OpenType table directory or table records'"),
  ]
  for (const validFile of validCases) {
    const valid = planAtlasDropImport(transfer([validFile]))
    assert.equal(await preflightAtlasDropImport(valid), valid)
  }

  for (const bytes of [
    bmpFixture(),
    formFixture(),
    mzFixture(),
    pdfFixture(),
    gifFixture("GIF87a"),
    gifFixture("GIF89a"),
    rtfFixture(),
    ftypFixture(),
    tarFixture(),
    ...printableSignatureFixtures().map(([, fixture]) => fixture),
  ]) {
    assert.throws(
      () => durableUploadMediaType({ name: "renamed.txt", type: "text/plain" }, bytes.buffer),
      /binary file signatures/u,
    )
  }
})

test("printable and offset marker dispatch uses only format-aware predicates", async () => {
  const source = await readFile(new URL("../lib/durable-document-import.js", import.meta.url), "utf8")
  const table = source.slice(source.indexOf("function hasNonTextSignature"), source.indexOf("export function durableUploadMediaType"))
  for (const predicate of [
    "hasPdfSignature",
    "hasRtfSignature",
    "hasGifSignature",
    "hasBmpSignature",
    "hasRiffSignature",
    "hasFormSignature",
    "hasId3Signature",
    "hasFlacSignature",
    "hasOggSignature",
    "hasMidiSignature",
    "hasBzipSignature",
    "hasWoffSignature",
    "hasOpenTypeCffSignature",
    "hasTarSignature",
    "hasIsoBmffSignature",
  ]) assert.match(table, new RegExp(`${predicate}\\(`, "u"))
  assert.doesNotMatch(table, /prefix\.(?:includes|startsWith)|asciiStartsWith\(bytes, "(?:GIF87a|GIF89a|ustar|ftyp)"/u)
  assert.doesNotMatch(source, /prefix\.includes\(PDF_MAGIC\)/u)
})

test("Atlas drop callback publication follows committed identity across abandoned and concurrent renders", async () => {
  const calls = []
  const target = { current: null }
  const cleanupFirst = commitAtlasDropCallbacks(target, {
    onImport: () => calls.push("first-import"),
    onError: () => calls.push("first-error"),
  })

  const abandonedRender = {
    onImport: () => calls.push("abandoned-import"),
    onError: () => calls.push("abandoned-error"),
  }
  assert.equal(typeof abandonedRender.onImport, "function")
  await Promise.resolve().then(() => target.current?.onImport())

  const cleanupLatest = commitAtlasDropCallbacks(target, {
    onImport: () => calls.push("latest-import"),
    onError: () => calls.push("latest-error"),
  })
  cleanupFirst()
  await Promise.resolve().then(() => target.current?.onError())
  assert.deepEqual(calls, ["first-import", "latest-error"])

  cleanupLatest()
  assert.equal(target.current, null)
})

test("file analysis ownership rejects a second file and ignores out-of-order completion", () => {
  const owner = createAtlasDropImportOwner()
  const first = { aborted: false, abort() { this.aborted = true } }
  const second = { aborted: false, abort() { this.aborted = true } }

  assert.equal(owner.busy(), false)
  assert.equal(owner.claim(first), true)
  assert.equal(owner.busy(), true)
  assert.equal(owner.claim(second), false)
  assert.equal(owner.release(second), false)
  owner.abort()
  assert.equal(first.aborted, true)
  assert.equal(second.aborted, false)
  assert.equal(owner.release(first), true)

  assert.equal(owner.claim(second), true)
  assert.equal(owner.release(first), false)
  assert.equal(owner.busy(), true)
  owner.abort()
  assert.equal(second.aborted, true)
  assert.equal(owner.release(second), true)
  assert.equal(owner.busy(), false)
})

test("commit-synchronous unmount cleanup suppresses authorization that resolves in the passive window", async () => {
  const target = { current: null }
  let imports = 0
  let resolveAuthorization
  const authorization = new Promise((resolve) => {
    resolveAuthorization = resolve
  })
  const cleanupAtUnmountCommit = commitAtlasDropCallbacks(target, {
    onImport: () => { imports += 1 },
    onError: () => undefined,
  })
  const completion = authorization.then(() => target.current?.onImport())

  cleanupAtUnmountCommit()
  resolveAuthorization({ canvasId: "canvas-after-unmount" })
  await completion
  assert.equal(imports, 0)
})

test("drop authorization establishes an exact durable canvas before upload and fails closed without one", async () => {
  const plan = planAtlasDropImport(transfer([file("ready.md", "text/markdown", "# Ready")]))
  const order = []
  const canvas = await authorizeAtlasDropImportTarget(plan, async () => {
    order.push("canvas")
    return { canvasId: "canvas-1", workspaceId: "workspace-1" }
  })
  order.push("upload")
  assert.deepEqual(order, ["canvas", "upload"])
  assert.equal(canvas.canvasId, "canvas-1")

  const writes = []
  async function uploadAfterCanvas(ensureCanvas) {
    const target = await authorizeAtlasDropImportTarget(plan, ensureCanvas)
    writes.push(["document", target.canvasId])
  }
  await assert.rejects(
    uploadAfterCanvas(null),
    (error) => error instanceof AtlasDropImportError && error.code === "canvas_unavailable",
  )
  assert.deepEqual(writes, [])
})

test("Atlas plans and gates before import, stores the exact point in retry state, and has no local asset path", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const helper = client.slice(
    client.indexOf("async function executeAtlasDocumentIngestionPlan"),
    client.indexOf("function safeDocumentImportError"),
  )
  const dropHandler = client.slice(
    client.indexOf("const importAtlasDrop = useCallback"),
    client.indexOf("const retryAtlasDropPlacement = useCallback"),
  )
  const dropRetry = client.slice(
    client.indexOf("const retryAtlasDropPlacement = useCallback"),
    client.indexOf("const resumeDocumentAnalysis = useCallback"),
  )
  const manualHandler = client.slice(
    client.indexOf("const importDocumentAndPlace = useCallback"),
    client.indexOf("const retryImportedDocumentPlacement = useCallback"),
  )
  const manualRetry = client.slice(
    client.indexOf("const retryImportedDocumentPlacement = useCallback"),
    client.indexOf("const placeImportedDatasourceDocument = useCallback"),
  )
  assert.match(client, /atlasDropWorldPoint\([\s\S]*planAtlasDropImport\(event\.dataTransfer\)/u)
  assert.match(client, /useLayoutEffect\(\(\) => \{[\s\S]*commitAtlasDropCallbacks\(atlasDropCallbacksRef,[\s\S]*onImport: onAtlasDropImport,[\s\S]*onError: onAtlasDropImportError,[\s\S]*\[onAtlasDropImport, onAtlasDropImportError\]/u)
  assert.match(client, /authorizeAtlasDropImportTarget\(plan, ensureCanvas\)[\s\S]*atlasDropCallbacksRef\.current\?\.onImport\(plan, point, targetCanvas\)/u)
  assert.doesNotMatch(client, /onAtlasDropImportRef\.current\s*=|onAtlasDropImportErrorRef\.current\s*=/u)
  assert.match(helper, /createAtlasDocumentTransformClient\(\)[\s\S]*executeIngestionPlan\(ATLAS_DROP_INGESTION_PLAN_ID[\s\S]*galaxyBrainAPI\.importDocument/u)
  assert.match(dropHandler, /targetCanvas\.workspaceId !== atlas\.workspaceId[\s\S]*executeAtlasDocumentIngestionPlan/u)
  assert.match(dropHandler, /atlasDropImportOwner\.claim\(abortController\)[\s\S]*executeAtlasDocumentIngestionPlan/u)
  assert.match(manualHandler, /atlasDropImportRegistered\(\)[\s\S]*documentImportBusyRef\.current = true[\s\S]*executeAtlasDocumentIngestionPlan/u)
  assert.doesNotMatch(dropHandler, /galaxyBrainAPI\.importDocument/u)
  assert.doesNotMatch(manualHandler, /galaxyBrainAPI\.importDocument/u)
  assert.doesNotMatch(dropRetry, /executeAtlasDocumentIngestionPlan|galaxyBrainAPI\.importDocument|transformDocument/u)
  assert.doesNotMatch(manualRetry, /executeAtlasDocumentIngestionPlan|galaxyBrainAPI\.importDocument|transformDocument/u)
  assert.match(client, /document: confirmation\.document,[\s\S]*operationId: confirmation\.placementOperationId,[\s\S]*point,[\s\S]*canvasId: targetCanvas\.canvasId/u)
  assert.match(dropHandler, /onPersisted:[\s\S]*currentAtlasTargetRef\.current[\s\S]*currentTarget\.canvasId === recovery\.canvasId[\s\S]*placeReference\(recovery\.document\.ref, recovery\.operationId, recovery\.point\)[\s\S]*setAtlasDropIngestionNotice/u)
  assert.match(manualHandler, /currentAtlasTargetRef\.current[\s\S]*currentTarget\.canvasId !== targetCanvasId[\s\S]*placeReference/u)
  assert.match(client, /placeReference\(recovery\.document\.ref, recovery\.operationId, recovery\.point\)/u)
  assert.match(client, /Retry the exact point without re-uploading/u)
  assert.match(client, /searchParams\.set\("canvas", recovery\.canvasId\)/u)
  assert.match(client, /setFocusPlacementId\(completion\.placementId\)/u)
  assert.match(client, /ingestionPlanTransformScope\(plan, result\.confirmation\.document, scopePrefix\)[\s\S]*Resume analysis/u)
  assert.match(client, /documentAnalysisContextKey\(tenantId, principalId, target\.workspaceId\)[\s\S]*currentContext !== recovery\.contextKey/u)
  assert.match(client, /documentAnalysisAbortRef\.current\?\.abort\(\)[\s\S]*documentAnalysisGenerationRef\.current[\s\S]*signal: abortController\.signal/u)
  assert.match(client, /latestContext !== recovery\.contextKey/u)
  assert.match(client, /bounded analysis window ended[\s\S]*registered fallback produced[\s\S]*partial representation/u)
  assert.match(client, /operation-storage-unavailable[\s\S]*Nothing was uploaded/u)
  assert.match(manualRetry, /recovery\.workspaceId !== atlas\.workspaceId[\s\S]*recovery\.canvasId !== atlas\.durableCanvas\?\.canvasId[\s\S]*placeReference\(recovery\.document\.ref, recovery\.operationId\)/u)
  assert.doesNotMatch(client, /@\/lib\/asset-store|indexedDB|URL\.createObjectURL|readAsDataURL|galaxyBrainService\.create/u)
})

test("manual import can leave replayable analysis running after the exact original is durable", async () => {
  const dialog = await readFile(new URL("../components/atlas/document-import-dialog.tsx", import.meta.url), "utf8")
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")

  assert.match(dialog, /closeBlocked = phase === "importing" \|\| phase === "placing"/u)
  assert.match(dialog, /phase === "transforming"[\s\S]*"Continue in background"/u)
  assert.match(dialog, /planAtlasFileImport\(file\)/u)
  assert.match(dialog, /\.md,[\s\S]*\.png,[\s\S]*\.webm/u)
  assert.match(dialog, /Preserve the exact file first/u)
  assert.match(dialog, /Document title/u)
  assert.match(dialog, /run the registered replayable analysis plan/u)
  assert.match(client, /documentImportPhase === "transforming" && importedDocument\) return/u)
  assert.match(client, /onPersisted:[\s\S]*replaceDocumentAnalysisState\(analysisStateForConfirmation[\s\S]*resumable: false, dismissible: false/u)
  assert.match(client, /const admissionPublished = new Promise<void>[\s\S]*onPersisted:[\s\S]*publishAdmission\(\)[\s\S]*void runImport\(\)[\s\S]*await admissionPublished/u)
  assert.match(client, /useEffect\(\(\) => \(\) => \{[\s\S]*atlasDropImportOwner\.abort\(\)/u)
  assert.match(client, /finally \{[\s\S]*atlasDropImportOwner\.release\(abortController\)/u)
  const placementCompletion = client.slice(
    client.indexOf("const completeReferencePlacement"),
    client.indexOf("const failReferencePlacement"),
  )
  assert.doesNotMatch(placementCompletion, /atlasDropImportOwner/u)
  assert.match(client, /!documentImportOpen && documentImportRecovery && documentImportError[\s\S]*Retry placement/u)
  assert.doesNotMatch(client, /Sign in again before importing this paper|The PDF exceeds/u)
})

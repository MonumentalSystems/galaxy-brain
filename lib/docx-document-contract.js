export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const MAX_DOCX_BYTES = 25 * 1024 * 1024
export const MAX_DOCX_ENTRIES = 4_096
export const MAX_DOCX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_DOCX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_DOCX_COMPRESSION_RATIO = 200

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const REQUIRED_PARTS = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"])
const ACTIVE_PART = /(?:^|\/)(?:activeX|embeddings|oleObject)(?:\/|$)|(?:^|\/)vba(?:Data\.xml|Project\.bin)$|\.(?:exe|dll|com|msi|js|mjs|cjs|vbs|vbe|ps1|bat|cmd|scr)$/iu
const DRIVE_PATH = /^[a-z]:/iu
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export class DocxDocumentContractError extends Error {}

function invalid(message = "Choose a valid non-macro DOCX file") {
  throw new DocxDocumentContractError(message)
}

export function isDocxCandidate(filename, mediaType = "") {
  const name = typeof filename === "string" ? filename.trim().toLowerCase() : ""
  const declared = typeof mediaType === "string" ? mediaType.split(";", 1)[0].trim().toLowerCase() : ""
  return name.endsWith(".docx") || declared === DOCX_MEDIA_TYPE
}

function uint16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) invalid()
  return view.getUint16(offset, true)
}

function uint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) invalid()
  return view.getUint32(offset, true)
}

function decodeName(bytes, utf8) {
  if (bytes.byteLength < 1 || bytes.byteLength > 1_024) invalid()
  try {
    if (utf8) return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (bytes.some((value) => value < 0x20 || value > 0x7e)) invalid()
    return String.fromCharCode(...bytes)
  } catch {
    invalid()
  }
}

function safePartName(name) {
  if (!name || name.length > 1_024 || CONTROL.test(name) || name.includes("\\")
    || name.startsWith("/") || DRIVE_PATH.test(name)) invalid()
  const segments = name.split("/")
  const directory = segments.at(-1) === ""
  const material = directory ? segments.slice(0, -1) : segments
  if (material.length < 1 || material.some((segment) => !segment || segment === "." || segment === "..")) invalid()
  return directory
}

function findEocd(bytes, view) {
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (uint32(view, offset) !== EOCD_SIGNATURE) continue
    if (offset + 22 + uint16(view, offset + 20) !== bytes.byteLength) invalid()
    return offset
  }
  invalid()
}

/**
 * Validate bounded ZIP metadata without expanding the package in the browser.
 * The API repeats these checks and additionally parses the required XML parts,
 * so this preflight is useful feedback rather than an authority boundary.
 */
export function validateDocxPackageMetadata(filename, mediaType, buffer) {
  if (typeof filename !== "string" || !filename.trim().toLowerCase().endsWith(".docx")) {
    invalid("DOCX files must use the .docx extension")
  }
  const declared = typeof mediaType === "string" ? mediaType.split(";", 1)[0].trim().toLowerCase() : ""
  if (declared && declared !== DOCX_MEDIA_TYPE) invalid("DOCX media type does not match its filename")
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 22 || buffer.byteLength > MAX_DOCX_BYTES) {
    invalid("Choose a DOCX file no larger than 25 MiB")
  }
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const eocd = findEocd(bytes, view)
  const disk = uint16(view, eocd + 4)
  const centralDisk = uint16(view, eocd + 6)
  const entriesOnDisk = uint16(view, eocd + 8)
  const entryCount = uint16(view, eocd + 10)
  const centralSize = uint32(view, eocd + 12)
  const centralOffset = uint32(view, eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount < 1 || entryCount > MAX_DOCX_ENTRIES
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== eocd || centralOffset < 4) invalid()

  const names = new Set()
  const namesFolded = new Set()
  const present = new Set()
  const ranges = []
  let cursor = centralOffset
  let expanded = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(view, cursor) !== CENTRAL_SIGNATURE) invalid()
    const madeBy = uint16(view, cursor + 4)
    const flags = uint16(view, cursor + 8)
    const method = uint16(view, cursor + 10)
    const crc = uint32(view, cursor + 16)
    const compressed = uint32(view, cursor + 20)
    const uncompressed = uint32(view, cursor + 24)
    const nameLength = uint16(view, cursor + 28)
    const extraLength = uint16(view, cursor + 30)
    const commentLength = uint16(view, cursor + 32)
    const startDisk = uint16(view, cursor + 34)
    const attributes = uint32(view, cursor + 38)
    const localOffset = uint32(view, cursor + 42)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (end > eocd || startDisk !== 0 || localOffset === 0xffffffff
      || compressed === 0xffffffff || uncompressed === 0xffffffff
      || (flags & 0x2041) !== 0 || (method !== 0 && method !== 8)) invalid()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const extraBytes = bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    for (let extraCursor = 0; extraCursor < extraBytes.byteLength;) {
      if (extraCursor + 4 > extraBytes.byteLength) invalid()
      const extraView = new DataView(extraBytes.buffer, extraBytes.byteOffset, extraBytes.byteLength)
      const extraId = uint16(extraView, extraCursor)
      const extraSize = uint16(extraView, extraCursor + 2)
      extraCursor += 4
      if (extraCursor + extraSize > extraBytes.byteLength || extraId === 0x0001) invalid()
      extraCursor += extraSize
    }
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0)
    const directory = safePartName(name)
    const folded = name.toLocaleLowerCase("en-US")
    if (names.has(name) || namesFolded.has(folded)) invalid()
    names.add(name)
    namesFolded.add(folded)
    if (ACTIVE_PART.test(name)) invalid("Macro, ActiveX, and embedded executable parts are not supported")

    const unixType = (madeBy >> 8) === 3 ? ((attributes >>> 16) & 0xf000) : 0
    const dosDirectory = (attributes & 0x10) !== 0
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) invalid()
    if (unixType === 0x4000 || dosDirectory) {
      if (!directory || compressed !== 0 || uncompressed !== 0) invalid()
    } else if (directory) invalid()

    if (!directory) {
      if (uncompressed > MAX_DOCX_ENTRY_BYTES) invalid("DOCX expanded entry exceeds the limit")
      expanded += uncompressed
      if (expanded > MAX_DOCX_EXPANDED_BYTES) invalid("DOCX expanded content exceeds the limit")
      if (uncompressed > 1_048_576 && (compressed === 0 || uncompressed / compressed > MAX_DOCX_COMPRESSION_RATIO)) {
        invalid("DOCX compression ratio exceeds the limit")
      }
      if (REQUIRED_PARTS.has(name)) {
        if (uncompressed < 16) invalid()
        present.add(name)
      }
    }

    if (uint32(view, localOffset) !== LOCAL_SIGNATURE) invalid()
    const localFlags = uint16(view, localOffset + 6)
    const localMethod = uint16(view, localOffset + 8)
    const localCrc = uint32(view, localOffset + 14)
    const localCompressed = uint32(view, localOffset + 18)
    const localUncompressed = uint32(view, localOffset + 22)
    const localNameLength = uint16(view, localOffset + 26)
    const localExtraLength = uint16(view, localOffset + 28)
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    const localExtra = bytes.subarray(
      localOffset + 30 + localNameLength,
      localOffset + 30 + localNameLength + localExtraLength,
    )
    for (let extraCursor = 0; extraCursor < localExtra.byteLength;) {
      if (extraCursor + 4 > localExtra.byteLength) invalid()
      const extraView = new DataView(localExtra.buffer, localExtra.byteOffset, localExtra.byteLength)
      const extraId = uint16(extraView, extraCursor)
      const extraSize = uint16(extraView, extraCursor + 2)
      extraCursor += 4
      if (extraCursor + extraSize > localExtra.byteLength || extraId === 0x0001) invalid()
      extraCursor += extraSize
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + compressed
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength
      || localName.some((value, nameIndex) => value !== nameBytes[nameIndex])
      || dataEnd > centralOffset
      || ((flags & 0x0008) === 0 && (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed))) invalid()
    let entryEnd = dataEnd
    if ((flags & 0x0008) !== 0) {
      if (![0, crc].includes(localCrc) || ![0, compressed].includes(localCompressed)
        || ![0, uncompressed].includes(localUncompressed)) invalid()
      if (uint32(view, entryEnd) === 0x08074b50) entryEnd += 4
      if (uint32(view, entryEnd) !== crc || uint32(view, entryEnd + 4) !== compressed
        || uint32(view, entryEnd + 8) !== uncompressed) invalid()
      entryEnd += 12
      if (entryEnd > centralOffset) invalid()
    }
    ranges.push([localOffset, entryEnd])
    cursor = end
  }
  if (cursor !== eocd || present.size !== REQUIRED_PARTS.size) invalid("DOCX package is missing required Word parts")
  ranges.sort((left, right) => left[0] - right[0])
  if (ranges[0][0] !== 0 || ranges.at(-1)[1] !== centralOffset) invalid()
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] !== ranges[index - 1][1]) invalid()
  }
  return Object.freeze({ mediaType: DOCX_MEDIA_TYPE, entryCount, expandedBytes: expanded })
}

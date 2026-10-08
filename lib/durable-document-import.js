import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import {
  isRasterImageCandidate,
  MAX_RASTER_IMAGE_BYTES,
  RasterImageContractError,
  rasterImageMediaType,
  rasterImageTypeForFilename,
} from "./raster-image-contract.js"
import {
  audioOriginalMediaType,
  AudioOriginalContractError,
  isAudioOriginalCandidate,
  MAX_AUDIO_ORIGINAL_BYTES,
} from "./audio-original-contract.js"
import {
  DOCX_MEDIA_TYPE,
  DocxDocumentContractError,
  isDocxCandidate,
  MAX_DOCX_BYTES,
  validateDocxPackageMetadata,
} from "./docx-document-contract.js"

export const DOCUMENT_IMPORT_SCHEMA_ID = "gb.document.import.v1"
export const MAX_IMPORT_FILE_BYTES = 100_000_000
export const MAX_IMPORT_METADATA_BYTES = 6_000
export const MAX_IMPORT_METADATA_HEADER_CHARS = 8_000

const PDF_MAGIC = "%PDF-"
const FILE_EXTENSION = /\.[a-z0-9]{1,10}$/u
const DISALLOWED_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

export class IngestionContractError extends Error {}

function bytesStartWith(bytes, signature, offset = 0) {
  if (bytes.byteLength < offset + signature.length) return false
  return signature.every((value, index) => bytes[offset + index] === value)
}

function asciiStartsWith(bytes, signature, offset = 0) {
  return bytesStartWith(bytes, Array.from(signature, (value) => value.charCodeAt(0)), offset)
}

function uint32(bytes, offset, littleEndian) {
  if (bytes.byteLength < offset + 4) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian)
}

function uint16(bytes, offset, littleEndian = false) {
  if (bytes.byteLength < offset + 2) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian)
}

function printableAscii(bytes, offset, length) {
  return bytes.byteLength >= offset + length
    && bytes.slice(offset, offset + length).every((value) => value >= 0x20 && value <= 0x7e)
}

function latin1(bytes, start = 0, end = bytes.byteLength) {
  return new TextDecoder("latin1").decode(bytes.slice(start, end))
}

function isPdfWhitespace(value) {
  return value === 0x00 || value === 0x09 || value === 0x0a
    || value === 0x0c || value === 0x0d || value === 0x20
}

function skipPdfWhitespace(bytes, offset, limit = bytes.byteLength) {
  let cursor = offset
  while (cursor < limit && isPdfWhitespace(bytes[cursor])) cursor += 1
  return cursor
}

function pdfUnsigned(bytes, offset, maxDigits, limit = bytes.byteLength) {
  let cursor = offset
  while (cursor < limit && cursor - offset < maxDigits && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1
  if (cursor === offset || (cursor < limit && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39)) return null
  return { value: Number(latin1(bytes, offset, cursor)), next: cursor }
}

function hasPdfXrefTable(bytes, offset, limit) {
  if (!asciiStartsWith(bytes, "xref", offset)) return false
  let cursor = skipPdfWhitespace(bytes, offset + 4, limit)
  if (cursor === offset + 4) return false
  const firstObject = pdfUnsigned(bytes, cursor, 10, limit)
  if (!firstObject) return false
  cursor = skipPdfWhitespace(bytes, firstObject.next, limit)
  if (cursor === firstObject.next) return false
  const objectCount = pdfUnsigned(bytes, cursor, 10, limit)
  if (!objectCount || objectCount.value < 1) return false
  cursor = skipPdfWhitespace(bytes, objectCount.next, limit)
  if (cursor === objectCount.next || cursor + 17 > limit) return false
  const entryOffset = pdfUnsigned(bytes, cursor, 10, limit)
  if (!entryOffset || entryOffset.next - cursor !== 10) return false
  cursor = skipPdfWhitespace(bytes, entryOffset.next, limit)
  if (cursor === entryOffset.next) return false
  const generation = pdfUnsigned(bytes, cursor, 5, limit)
  if (!generation || generation.next - cursor !== 5) return false
  cursor = skipPdfWhitespace(bytes, generation.next, limit)
  if (cursor === generation.next || (bytes[cursor] !== 0x6e && bytes[cursor] !== 0x66)) return false
  return cursor + 1 < limit && isPdfWhitespace(bytes[cursor + 1])
}

function hasPdfXrefStreamObject(bytes, offset, limit) {
  let cursor = offset
  const objectNumber = pdfUnsigned(bytes, cursor, 10, limit)
  if (!objectNumber) return false
  cursor = skipPdfWhitespace(bytes, objectNumber.next, limit)
  if (cursor === objectNumber.next) return false
  const generation = pdfUnsigned(bytes, cursor, 5, limit)
  if (!generation) return false
  cursor = skipPdfWhitespace(bytes, generation.next, limit)
  if (cursor === generation.next || !asciiStartsWith(bytes, "obj", cursor)) return false
  cursor += 3
  if (cursor >= limit || !isPdfWhitespace(bytes[cursor])) return false
  const header = latin1(bytes, cursor, Math.min(limit, cursor + 4096))
  const whitespace = "[\\u0000\\u0009\\u000a\\u000c\\u000d\\u0020]*"
  return new RegExp(`/Type${whitespace}/XRef(?=[\\u0000\\u0009\\u000a\\u000c\\u000d\\u0020/<>{}\\[\\]()])`, "u").test(header)
    && /\/W(?=[\u0000\u0009\u000a\u000c\u000d\u0020\[])/u.test(header)
}

function hasBmpSignature(bytes) {
  if (!asciiStartsWith(bytes, "BM") || bytes.byteLength < 26) return false
  const fileSize = uint32(bytes, 2, true)
  const pixelOffset = uint32(bytes, 10, true)
  const dibHeaderSize = uint32(bytes, 14, true)
  return fileSize === bytes.byteLength
    && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
    && pixelOffset >= 26 && pixelOffset <= fileSize
    && dibHeaderSize >= 12 && dibHeaderSize <= fileSize - 14
}

function hasFormSignature(bytes) {
  if (!asciiStartsWith(bytes, "FORM") || bytes.byteLength < 12) return false
  const payloadLength = uint32(bytes, 4, false)
  return payloadLength === bytes.byteLength - 8
    && printableAscii(bytes, 8, 4)
}

function hasMzExecutableSignature(bytes) {
  if (!asciiStartsWith(bytes, "MZ") || bytes.byteLength < 68) return false
  const executableOffset = uint32(bytes, 0x3c, true)
  if (executableOffset === null || executableOffset < 64 || executableOffset + 2 > bytes.byteLength) return false
  return asciiStartsWith(bytes, "PE\u0000\u0000", executableOffset)
    || asciiStartsWith(bytes, "NE", executableOffset)
    || asciiStartsWith(bytes, "LE", executableOffset)
    || asciiStartsWith(bytes, "LX", executableOffset)
}

function hasRiffSignature(bytes) {
  return asciiStartsWith(bytes, "RIFF")
    && bytes.byteLength >= 12
    && uint32(bytes, 4, true) === bytes.byteLength - 8
    && printableAscii(bytes, 8, 4)
}

function hasId3Signature(bytes) {
  if (!asciiStartsWith(bytes, "ID3") || bytes.byteLength < 10) return false
  const version = bytes[3]
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : version === 4 ? 0xf0 : null
  if (allowedFlags === null || bytes[4] === 0xff || (bytes[5] & ~allowedFlags) !== 0) return false
  if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => value >= 0x80)) return false
  const payloadLength = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]
  const footerLength = version === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0
  return 10 + payloadLength + footerLength <= bytes.byteLength
}

function hasFlacSignature(bytes) {
  return asciiStartsWith(bytes, "fLaC")
    && bytes.byteLength >= 42
    && (bytes[4] & 0x7f) === 0
    && ((bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) === 34
}

function hasOggSignature(bytes) {
  if (!asciiStartsWith(bytes, "OggS") || bytes.byteLength < 27 || bytes[4] !== 0) return false
  const segmentCount = bytes[26]
  const headerLength = 27 + segmentCount
  if (headerLength > bytes.byteLength) return false
  let payloadLength = 0
  for (let index = 27; index < headerLength; index += 1) payloadLength += bytes[index]
  return headerLength + payloadLength <= bytes.byteLength
}

function hasMidiSignature(bytes) {
  const format = uint16(bytes, 8)
  const tracks = uint16(bytes, 10)
  const division = uint16(bytes, 12)
  return asciiStartsWith(bytes, "MThd")
    && bytes.byteLength >= 14
    && uint32(bytes, 4, false) === 6
    && format !== null && format <= 2
    && tracks !== null && tracks > 0
    && division !== null && division !== 0
}

function hasBzipSignature(bytes) {
  return asciiStartsWith(bytes, "BZh")
    && bytes.byteLength >= 10
    && bytes[3] >= 0x31 && bytes[3] <= 0x39
    && (
      bytesStartWith(bytes, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 4)
      || bytesStartWith(bytes, [0x17, 0x72, 0x45, 0x38, 0x50, 0x90], 4)
    )
}

function hasWoffSignature(bytes, signature, headerLength) {
  if (!asciiStartsWith(bytes, signature) || bytes.byteLength < headerLength) return false
  const tableCount = uint16(bytes, 12)
  const totalSfntSize = uint32(bytes, 16, false)
  if (uint32(bytes, 8, false) !== bytes.byteLength
    || tableCount === null || tableCount < 1
    || uint16(bytes, 14) !== 0
    || totalSfntSize === null || totalSfntSize < 12 + (tableCount * 16)) return false
  if (signature === "wOFF") {
    const directoryEnd = headerLength + (tableCount * 20)
    if (directoryEnd > bytes.byteLength) return false
    for (let index = 0; index < tableCount; index += 1) {
      const record = headerLength + (index * 20)
      const offset = uint32(bytes, record + 4, false)
      const compressedLength = uint32(bytes, record + 8, false)
      const originalLength = uint32(bytes, record + 12, false)
      if (!printableAscii(bytes, record, 4)
        || offset === null || compressedLength === null || originalLength === null
        || offset < directoryEnd || offset % 4 !== 0
        || compressedLength < 1 || compressedLength > originalLength
        || compressedLength > bytes.byteLength - offset) return false
    }
    return true
  }
  const compressedSize = uint32(bytes, 20, false)
  return compressedSize !== null && compressedSize > 0
    && compressedSize <= bytes.byteLength - headerLength - tableCount
}

function hasOpenTypeCffSignature(bytes) {
  if (!asciiStartsWith(bytes, "OTTO") || bytes.byteLength < 28) return false
  const tableCount = uint16(bytes, 4)
  if (tableCount === null || tableCount < 1 || tableCount > 4095) return false
  const largestPower = 2 ** Math.floor(Math.log2(tableCount))
  if (uint16(bytes, 6) !== largestPower * 16
    || uint16(bytes, 8) !== Math.log2(largestPower)
    || uint16(bytes, 10) !== (tableCount * 16) - (largestPower * 16)) return false
  const directoryEnd = 12 + (tableCount * 16)
  if (directoryEnd > bytes.byteLength) return false
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + (index * 16)
    const offset = uint32(bytes, record + 8, false)
    const length = uint32(bytes, record + 12, false)
    if (!printableAscii(bytes, record, 4)
      || offset === null || length === null
      || offset < directoryEnd || offset > bytes.byteLength
      || length > bytes.byteLength - offset) return false
  }
  return true
}

function hasPdfSignature(bytes) {
  if (bytes.byteLength < 32 || !asciiStartsWith(bytes, PDF_MAGIC)) return false
  const major = bytes[5]
  const minor = bytes[7]
  if (!((major === 0x31 && minor >= 0x30 && minor <= 0x39) || (major === 0x32 && minor === 0x30))
    || bytes[6] !== 0x2e || (bytes[8] !== 0x0a && bytes[8] !== 0x0d)) return false
  const tailStart = Math.max(0, bytes.byteLength - 2048)
  const match = latin1(bytes, tailStart).match(/startxref[\u0000\u0009\u000a\u000c\u000d\u0020]+([0-9]{1,15})[\u0000\u0009\u000a\u000c\u000d\u0020]+%%EOF[\u0000\u0009\u000a\u000c\u000d\u0020]*$/u)
  if (!match) return false
  const xrefOffset = Number(match[1])
  const startxrefOffset = tailStart + (match.index ?? 0)
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 9 || xrefOffset >= startxrefOffset) return false
  return hasPdfXrefTable(bytes, xrefOffset, startxrefOffset)
    || hasPdfXrefStreamObject(bytes, xrefOffset, startxrefOffset)
}

function skipGifSubBlocks(bytes, offset) {
  let cursor = offset
  while (cursor < bytes.byteLength) {
    const length = bytes[cursor]
    cursor += 1
    if (length === 0) return cursor
    if (cursor + length > bytes.byteLength) return null
    cursor += length
  }
  return null
}

function hasGifSignature(bytes) {
  if (!(asciiStartsWith(bytes, "GIF87a") || asciiStartsWith(bytes, "GIF89a")) || bytes.byteLength < 14) return false
  const width = uint16(bytes, 6, true)
  const height = uint16(bytes, 8, true)
  if (width === 0 || height === 0) return false
  const packed = bytes[10]
  let cursor = 13 + ((packed & 0x80) !== 0 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0)
  if (cursor >= bytes.byteLength) return false
  let sawImage = false
  while (cursor < bytes.byteLength) {
    const marker = bytes[cursor]
    if (marker === 0x3b) return sawImage && cursor === bytes.byteLength - 1
    if (marker === 0x21) {
      if (cursor + 2 >= bytes.byteLength) return false
      const next = skipGifSubBlocks(bytes, cursor + 2)
      if (next === null) return false
      cursor = next
      continue
    }
    if (marker !== 0x2c || cursor + 10 > bytes.byteLength) return false
    const imageWidth = uint16(bytes, cursor + 5, true)
    const imageHeight = uint16(bytes, cursor + 7, true)
    if (imageWidth === 0 || imageHeight === 0) return false
    const imagePacked = bytes[cursor + 9]
    cursor += 10 + ((imagePacked & 0x80) !== 0 ? 3 * (2 ** ((imagePacked & 0x07) + 1)) : 0)
    if (cursor >= bytes.byteLength || bytes[cursor] < 2 || bytes[cursor] > 12) return false
    const next = skipGifSubBlocks(bytes, cursor + 1)
    if (next === null) return false
    cursor = next
    sawImage = true
  }
  return false
}

function hasRtfSignature(bytes) {
  if (bytes.byteLength < 12 || !asciiStartsWith(bytes, "{\\rtf1")) return false
  const delimiter = bytes[6]
  if (!(delimiter === 0x20 || delimiter === 0x09 || delimiter === 0x0a || delimiter === 0x0d || delimiter === 0x5c)) return false
  let depth = 0
  let escaped = false
  let finalContent = -1
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = bytes[index]
    if (![0x09, 0x0a, 0x0d, 0x20].includes(value)) finalContent = index
    if (escaped) {
      escaped = false
      continue
    }
    if (value === 0x5c) {
      escaped = true
    } else if (value === 0x7b) {
      depth += 1
    } else if (value === 0x7d) {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && finalContent >= 0 && bytes[finalContent] === 0x7d
}

function hasIsoBmffSignature(bytes) {
  if (bytes.byteLength < 16 || !asciiStartsWith(bytes, "ftyp", 4)) return false
  const boxSize = uint32(bytes, 0, false)
  if (boxSize === null || boxSize < 16 || boxSize > bytes.byteLength || (boxSize - 16) % 4 !== 0
    || !printableAscii(bytes, 8, 4)) return false
  for (let offset = 16; offset < boxSize; offset += 4) {
    if (!printableAscii(bytes, offset, 4)) return false
  }
  return true
}

function tarOctal(bytes, offset, length) {
  const value = latin1(bytes, offset, offset + length).replace(/[\u0000 ]+$/gu, "").replace(/^ +/gu, "")
  return /^[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : null
}

function hasTarSignature(bytes) {
  if (bytes.byteLength < 1536 || bytes.byteLength % 512 !== 0 || !asciiStartsWith(bytes, "ustar", 257)) return false
  if (!((bytes[262] === 0x00 || bytes[262] === 0x20)
    && ((bytes[263] === 0x30 && bytes[264] === 0x30) || (bytes[263] === 0x20 && bytes[264] === 0x00)))) return false
  if (!bytes.slice(0, 100).some((value) => value !== 0)) return false
  const expectedChecksum = tarOctal(bytes, 148, 8)
  if (expectedChecksum === null) return false
  let checksum = 0
  for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : bytes[index]
  if (checksum !== expectedChecksum) return false
  return bytes.slice(bytes.byteLength - 1024).every((value) => value === 0)
}

function hasNonTextSignature(bytes) {
  return (
    hasPdfSignature(bytes)
    || hasRtfSignature(bytes)
    || hasGifSignature(bytes)
    || hasBmpSignature(bytes)
    || hasRiffSignature(bytes)
    || hasFormSignature(bytes)
    || hasId3Signature(bytes)
    || hasFlacSignature(bytes)
    || hasOggSignature(bytes)
    || hasMidiSignature(bytes)
    || asciiStartsWith(bytes, "PK\u0003\u0004")
    || asciiStartsWith(bytes, "PK\u0005\u0006")
    || asciiStartsWith(bytes, "PK\u0007\u0008")
    || asciiStartsWith(bytes, "Rar!\u001a\u0007")
    || asciiStartsWith(bytes, "7z\u00bc\u00af\u0027\u001c")
    || hasBzipSignature(bytes)
    || asciiStartsWith(bytes, "SQLite format 3\u0000")
    || hasMzExecutableSignature(bytes)
    || asciiStartsWith(bytes, "\u007fELF")
    || asciiStartsWith(bytes, "\u0000asm")
    || hasWoffSignature(bytes, "wOFF", 44)
    || hasWoffSignature(bytes, "wOF2", 48)
    || hasOpenTypeCffSignature(bytes)
    || hasTarSignature(bytes)
    || hasIsoBmffSignature(bytes)
    || bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || bytesStartWith(bytes, [0xff, 0xd8, 0xff])
    || bytesStartWith(bytes, [0x49, 0x49, 0x2a, 0x00])
    || bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
    || bytesStartWith(bytes, [0x00, 0x00, 0x01, 0x00])
    || bytesStartWith(bytes, [0x1f, 0x8b])
    || bytesStartWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || bytesStartWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])
    || bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    || bytesStartWith(bytes, [0xca, 0xfe, 0xba, 0xbe])
    || bytesStartWith(bytes, [0xfe, 0xed, 0xfa, 0xce])
    || bytesStartWith(bytes, [0xfe, 0xed, 0xfa, 0xcf])
    || bytesStartWith(bytes, [0xce, 0xfa, 0xed, 0xfe])
    || bytesStartWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])
  )
}

/**
 * Validate exact browser bytes before they enter the durable ingestion spine.
 * PDFs require a true version header and bounded cross-reference/EOF shape;
 * authored text must be valid UTF-8 with an explicit text/JSON/XML media type.
 */
export function durableUploadMediaType(file, bytes) {
  if (
    !file || typeof file !== "object" || typeof file.name !== "string"
    || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 1
  ) throw new IngestionContractError("Choose a non-empty durable source file")
  const filename = file.name.trim()
  const extension = filename.toLowerCase().match(FILE_EXTENSION)?.[0] || ""
  const declared = typeof file.type === "string"
    ? file.type.split(";", 1)[0].trim().toLowerCase()
    : ""
  const byteView = new Uint8Array(bytes)
  if (isDocxCandidate(filename, declared)) {
    try {
      validateDocxPackageMetadata(filename, declared, bytes)
      return DOCX_MEDIA_TYPE
    } catch (error) {
      if (error instanceof DocxDocumentContractError) {
        throw new IngestionContractError(error.message)
      }
      throw error
    }
  }
  if (rasterImageTypeForFilename(filename) !== null || declared.startsWith("image/")) {
    if (bytes.byteLength > MAX_RASTER_IMAGE_BYTES) {
      throw new IngestionContractError("Choose a raster image no larger than 20 MiB")
    }
    try {
      return rasterImageMediaType(filename, declared, byteView)
    } catch (error) {
      if (error instanceof RasterImageContractError) {
        throw new IngestionContractError(error.message)
      }
      throw error
    }
  }
  if (isAudioOriginalCandidate(filename, declared, byteView)) {
    if (bytes.byteLength > MAX_AUDIO_ORIGINAL_BYTES) {
      throw new IngestionContractError("Choose a WebM/Opus audio file no larger than 20 MiB")
    }
    try {
      return audioOriginalMediaType(filename, declared, byteView)
    } catch (error) {
      if (error instanceof AudioOriginalContractError) {
        throw new IngestionContractError(error.message)
      }
      throw error
    }
  }
  if (extension === ".pdf") {
    if (!hasPdfSignature(byteView) || (declared && declared !== "application/pdf")) {
      throw new IngestionContractError("Choose a valid PDF file")
    }
    return "application/pdf"
  }
  if (!extension || !(declared.startsWith("text/") || declared === "application/json" || declared === "application/xml")) {
    throw new IngestionContractError("Choose a UTF-8 text, code, Markdown, JSON, or XML file")
  }
  if (hasNonTextSignature(byteView)) {
    throw new IngestionContractError("Authored text files cannot contain PDF, rich-media, archive, executable, or binary file signatures")
  }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new IngestionContractError("Authored text files must contain valid UTF-8")
  }
  if (DISALLOWED_TEXT_CONTROL.test(text)) {
    throw new IngestionContractError("Authored text files cannot contain binary control characters")
  }
  return declared
}

function characterCount(value) {
  return Array.from(value).length
}

function validateIngestionPlanClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestionContractError("Invalid ingestion plan claim")
  }
  if (Object.keys(value).sort().join("\n") !== ["contentSha256", "id", "version"].join("\n")) {
    throw new IngestionContractError("Invalid ingestion plan claim")
  }
  if (
    typeof value.id !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value.id)
    || typeof value.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.version)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
  ) {
    throw new IngestionContractError("Invalid ingestion plan claim")
  }
  return Object.freeze({ id: value.id, version: value.version, contentSha256: value.contentSha256 })
}

function validateIngestionPlanEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestionContractError("Invalid document import ingestion_plan")
  }
  const keys = [
    "contentSha256", "id", "implementationId", "output", "owner", "persist",
    "schemaId", "source", "transformPolicy", "version",
  ]
  if (Object.keys(value).sort().join("\n") !== keys.join("\n") || value.schemaId !== "gb.ingestion-plan.v1") {
    throw new IngestionContractError("Invalid document import ingestion_plan")
  }
  const claim = validateIngestionPlanClaim({
    id: value.id,
    version: value.version,
    contentSha256: value.contentSha256,
  })
  if (
    !value.owner || Object.keys(value.owner).sort().join("\n") !== "pluginId\npluginVersion"
    || typeof value.owner.pluginId !== "string" || typeof value.owner.pluginVersion !== "string"
    || typeof value.implementationId !== "string"
    || !value.source || Object.keys(value.source).sort().join("\n") !== "contributionId\nimplementationId"
    || typeof value.source.contributionId !== "string" || typeof value.source.implementationId !== "string"
    || !value.persist
    || Object.keys(value.persist).sort().join("\n") !== "implementationId\noriginalRequired\nrouteId"
    || typeof value.persist.routeId !== "string" || typeof value.persist.implementationId !== "string"
    || value.persist.originalRequired !== true
    || !value.transformPolicy
    || Object.keys(value.transformPolicy).sort().join("\n") !== "implementationId\ntransforms"
    || typeof value.transformPolicy.implementationId !== "string"
    || !Array.isArray(value.transformPolicy.transforms)
    || value.transformPolicy.transforms.length !== 3
    || !value.output || Object.keys(value.output).sort().join("\n") !== "kind\nrevisionPolicy"
    || value.output.kind !== "document" || value.output.revisionPolicy !== "pinned"
  ) throw new IngestionContractError("Invalid document import ingestion_plan")
  const transforms = value.transformPolicy.transforms.map((transform) => {
    if (
      !transform || typeof transform !== "object" || Array.isArray(transform)
      || Object.keys(transform).sort().join("\n") !== "contributionId\nimplementationId"
      || typeof transform.contributionId !== "string" || typeof transform.implementationId !== "string"
    ) throw new IngestionContractError("Invalid document import ingestion_plan")
    return Object.freeze({
      contributionId: transform.contributionId,
      implementationId: transform.implementationId,
    })
  })
  return Object.freeze({
    schemaId: value.schemaId,
    ...claim,
    owner: Object.freeze({ ...value.owner }),
    implementationId: value.implementationId,
    source: Object.freeze({ ...value.source }),
    persist: Object.freeze({ ...value.persist }),
    transformPolicy: Object.freeze({
      implementationId: value.transformPolicy.implementationId,
      transforms: Object.freeze(transforms),
    }),
    output: Object.freeze({ ...value.output }),
  })
}

function canonicalDataJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDataJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalDataJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function encodeDurableImportMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestionContractError("Import metadata must be an object")
  }
  const sourceKind = value.sourceKind || "upload"
  if (
    typeof value.title !== "string" || characterCount(value.title.trim()) < 1 || characterCount(value.title.trim()) > 500
    || typeof value.filename !== "string" || characterCount(value.filename.trim()) < 1 || characterCount(value.filename.trim()) > 512
    || !["upload", "url", "arxiv", "legacy-paper", "datasource"].includes(sourceKind)
    || (value.sourceUri != null && (typeof value.sourceUri !== "string" || characterCount(value.sourceUri.trim()) > 4096))
    || (value.arxivId != null && (typeof value.arxivId !== "string" || characterCount(value.arxivId.trim()) > 200))
    || (value.captureIntentSha256 != null && (
      typeof value.captureIntentSha256 !== "string"
      || !SHA256.test(value.captureIntentSha256)
      || sourceKind !== "url"
    ))
  ) throw new IngestionContractError("Invalid durable import metadata")

  const normalized = {
    title: value.title.trim(),
    filename: value.filename.trim(),
    sourceKind,
    sourceUri: value.sourceUri?.trim() || null,
    arxivId: value.arxivId?.trim() || null,
  }
  if (value.captureIntentSha256 !== undefined) {
    normalized.captureIntentSha256 = value.captureIntentSha256
  }
  if (value.ingestionPlan !== undefined) {
    normalized.ingestionPlan = validateIngestionPlanClaim(value.ingestionPlan)
  }
  const bytes = new TextEncoder().encode(JSON.stringify(normalized))
  if (bytes.byteLength > MAX_IMPORT_METADATA_BYTES) {
    throw new IngestionContractError("Import metadata exceeds 6000 UTF-8 bytes")
  }
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  if (encoded.length > MAX_IMPORT_METADATA_HEADER_CHARS) {
    throw new IngestionContractError("Encoded import metadata exceeds the header limit")
  }
  return encoded
}

export function createDocumentImportIdempotencyKey(operationHash) {
  if (typeof operationHash !== "string" || !SHA256.test(operationHash)) {
    throw new IngestionContractError("Document import operation hash must be a lowercase SHA-256")
  }
  return `document-import:${operationHash}`
}

function hexDigest(value) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function placementUuidFromHash(hash) {
  const value = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17, 32)}`
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export async function prepareDurableDocumentImport(file, metadata) {
  if (
    !file || typeof file !== "object" || typeof file.arrayBuffer !== "function"
    || !Number.isSafeInteger(file.size) || file.size < 1
  ) {
    throw new IngestionContractError("Choose a non-empty file no larger than 100 MB")
  }
  const candidateFilename = typeof metadata?.filename === "string" ? metadata.filename : file.name
  if (isDocxCandidate(candidateFilename, file.type) && file.size > MAX_DOCX_BYTES) {
    throw new IngestionContractError("Choose a DOCX file no larger than 25 MiB")
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new IngestionContractError("Choose a non-empty file no larger than 100 MB")
  }
  const metadataHeader = encodeDurableImportMetadata(metadata)
  if (isRasterImageCandidate(metadata.filename, file.type) && file.size > MAX_RASTER_IMAGE_BYTES) {
    throw new IngestionContractError("Choose a raster image no larger than 20 MiB")
  }
  if (isAudioOriginalCandidate(metadata.filename, file.type) && file.size > MAX_AUDIO_ORIGINAL_BYTES) {
    throw new IngestionContractError("Choose a WebM/Opus audio file no larger than 20 MiB")
  }
  const bytes = await file.arrayBuffer()
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size) {
    throw new IngestionContractError("The selected file changed while it was being prepared")
  }
  const mediaType = durableUploadMediaType({
    name: metadata.filename,
    type: typeof file.type === "string" ? file.type : "",
  }, bytes)
  const contentSha256 = hexDigest(await crypto.subtle.digest("SHA-256", bytes))
  const operationIdentity = mediaType === "application/pdf"
    ? `${DOCUMENT_IMPORT_SCHEMA_ID}\n${contentSha256}\n${metadataHeader}`
    : `${DOCUMENT_IMPORT_SCHEMA_ID}.media-v1\n${contentSha256}\n${mediaType}\n${metadataHeader}`
  const operationMaterial = new TextEncoder().encode(operationIdentity)
  const operationHash = hexDigest(await crypto.subtle.digest("SHA-256", operationMaterial))
  return Object.freeze({
    bytes,
    contentSha256,
    mediaType,
    idempotencyKey: createDocumentImportIdempotencyKey(operationHash),
    metadataHeader,
    placementOperationId: placementUuidFromHash(operationHash),
  })
}

function requireString(value, field, maximum = 512) {
  if (typeof value !== "string" || characterCount(value) < 1 || characterCount(value) > maximum) {
    throw new IngestionContractError(`Invalid document import ${field}`)
  }
  return value
}

export function validateDurableDocumentImport(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestionContractError("Document import response must be an object")
  }
  if (value.schemaId !== DOCUMENT_IMPORT_SCHEMA_ID || value.persisted !== true) {
    throw new IngestionContractError("Document import response has an unsupported schema")
  }
  const expectedKeys = [
    "artifact_id", "byte_size", "content_sha256", "deduplicatedArtifact", "display_filename",
    "document_id", "media_type", "original_filename", "persisted", "ref", "replayed",
    "ingestion_plan", "revision_id", "revision_sha256", "schemaId", "source_id", "source_kind", "source_uri",
    "title", "version",
  ]
  if (Object.keys(value).sort().join("\n") !== expectedKeys.sort().join("\n")) {
    throw new IngestionContractError("Document import response has unexpected fields")
  }
  for (const field of ["document_id", "revision_id", "artifact_id", "source_id"]) {
    if (!UUID.test(requireString(value[field], field))) {
      throw new IngestionContractError(`Invalid document import ${field}`)
    }
  }
  for (const field of ["content_sha256", "revision_sha256"]) {
    if (!SHA256.test(requireString(value[field], field, 64))) {
      throw new IngestionContractError(`Invalid document import ${field}`)
    }
  }
  requireString(value.title, "title", 500)
  requireString(value.display_filename, "display_filename", 512)
  requireString(value.media_type, "media_type", 200)
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new IngestionContractError("Invalid document import version")
  }
  if (!Number.isSafeInteger(value.byte_size) || value.byte_size < 1 || value.byte_size > MAX_IMPORT_FILE_BYTES) {
    throw new IngestionContractError("Invalid document import byte_size")
  }
  if (!["upload", "url", "arxiv", "legacy-paper", "datasource"].includes(value.source_kind)) {
    throw new IngestionContractError("Invalid document import source_kind")
  }
  for (const field of ["replayed", "deduplicatedArtifact"]) {
    if (typeof value[field] !== "boolean") throw new IngestionContractError(`Invalid document import ${field}`)
  }
  for (const field of ["original_filename", "source_uri"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new IngestionContractError(`Invalid document import ${field}`)
    }
  }
  const ingestionPlan = value.ingestion_plan === null ? null : validateIngestionPlanEvidence(value.ingestion_plan)
  if (expected.ingestionPlan === undefined && ingestionPlan !== null) {
    throw new IngestionContractError("Document import response has unexpected ingestion plan evidence")
  }
  if (expected.ingestionPlan !== undefined) {
    const expectedPlan = validateIngestionPlanEvidence(expected.ingestionPlan)
    if (!ingestionPlan || canonicalDataJson(ingestionPlan) !== canonicalDataJson(expectedPlan)) {
      throw new IngestionContractError("Document import response has different ingestion plan evidence")
    }
  }
  const expectedRef = createGalaxyObjectReference("document", value.document_id, {
    mode: "pinned",
    revision: `sha256:${value.revision_sha256}`,
  })
  if (!parseGalaxyObjectReference(value.ref) || value.ref !== expectedRef) {
    throw new IngestionContractError("Document import response has an invalid pinned reference")
  }
  return Object.freeze({ ...value, ingestion_plan: ingestionPlan })
}

export function deriveImportedDocumentReference(value) {
  return validateDurableDocumentImport(value).ref
}

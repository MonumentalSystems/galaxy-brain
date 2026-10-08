export const AUDIO_ORIGINAL_SCHEMA_ID = "gb.audio-original.v1"
export const AUDIO_ORIGINAL_MEDIA_TYPE = "audio/webm"
export const MAX_AUDIO_ORIGINAL_BYTES = 20 * 1024 * 1024

const AUDIO_LIKE_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba", ".webm",
])
const VIDEO_LIKE_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"])
const SHA256 = /^[0-9a-f]{64}$/u
const MANIFEST_KEYS = new Set([
  "schemaId", "container", "codec", "mediaType", "trackCount", "channels", "byteSize", "contentSha256",
])

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const DOC_TYPE = 0x4282
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const CODEC_ID = 0x86
const CODEC_PRIVATE = 0x63a2
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const MUXING_APP = 0x4d80
const WRITING_APP = 0x5741
const TRACK_NUMBER = 0xd7
const TRACK_UID = 0x73c5
const FLAG_ENABLED = 0xb9
const FLAG_DEFAULT = 0x88
const FLAG_FORCED = 0x55aa
const FLAG_LACING = 0x9c
const DEFAULT_DURATION = 0x23e383
const TRACK_NAME = 0x536e
const LANGUAGE = 0x22b59c
const CODEC_DELAY = 0x56aa
const SEEK_PRE_ROLL = 0x56bb
const AUDIO = 0xe1
const SAMPLING_FREQUENCY = 0xb5
const OUTPUT_SAMPLING_FREQUENCY = 0x78b5
const CHANNELS = 0x9f
const BIT_DEPTH = 0x6264
const CLUSTER = 0x1f43b675
const CLUSTER_TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3
const VOID = 0xec
const CRC32 = 0xbf
const MAX_ELEMENTS = 100_000

export class AudioOriginalContractError extends Error {}

function extensionOf(filename) {
  if (typeof filename !== "string") return ""
  const index = filename.lastIndexOf(".")
  return index > 0 ? filename.slice(index).trim().toLowerCase() : ""
}

function baseMediaType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : ""
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

export function hasWebmSignature(value) {
  const bytes = asBytes(value)
  return Boolean(bytes && bytes.byteLength >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
}

export function isAudioOriginalCandidate(filename, declaredMediaType, value) {
  const extension = extensionOf(filename)
  const mediaType = baseMediaType(declaredMediaType)
  return AUDIO_LIKE_EXTENSIONS.has(extension)
    || VIDEO_LIKE_EXTENSIONS.has(extension)
    || mediaType.startsWith("audio/")
    || mediaType.startsWith("video/")
    || hasWebmSignature(value)
}

function readVint(bytes, offset, maximumLength, preserveMarker, label) {
  if (offset >= bytes.byteLength) throw new AudioOriginalContractError(`${label} is truncated`)
  const first = bytes[offset]
  let length = 1
  let marker = 0x80
  while (length <= maximumLength && (first & marker) === 0) {
    length += 1
    marker >>= 1
  }
  if (length > maximumLength || offset + length > bytes.byteLength) {
    throw new AudioOriginalContractError(`${label} is invalid`)
  }
  let value = BigInt(preserveMarker ? first : first & (marker - 1))
  for (let index = 1; index < length; index += 1) value = (value << 8n) | BigInt(bytes[offset + index])
  const unknown = !preserveMarker && value === (1n << BigInt(7 * length)) - 1n
  if (!preserveMarker && !unknown && length > 1
    && value < (1n << BigInt(7 * (length - 1))) - 1n) {
    throw new AudioOriginalContractError(`${label} is not minimally encoded`)
  }
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AudioOriginalContractError(`${label} is too large`)
  return { length, value: unknown ? 0 : Number(value), unknown }
}

function elementAt(bytes, offset, boundary, { allowUnknownSize = false } = {}) {
  const id = readVint(bytes, offset, 4, true, "WebM element identifier")
  const size = readVint(bytes, offset + id.length, 8, false, "WebM element size")
  const dataStart = offset + id.length + size.length
  if (size.unknown) {
    if (!allowUnknownSize) throw new AudioOriginalContractError("WebM contains an unsupported unknown-size element")
    return { id: id.value, dataStart, dataEnd: boundary, next: boundary, unknownSize: true }
  }
  const dataEnd = dataStart + size.value
  if (dataEnd < dataStart || dataEnd > boundary) throw new AudioOriginalContractError("WebM element exceeds its container")
  return { id: id.value, dataStart, dataEnd, next: dataEnd, unknownSize: false }
}

function childElements(bytes, start, end, state) {
  const result = []
  let offset = start
  while (offset < end) {
    state.count += 1
    if (state.count > MAX_ELEMENTS) throw new AudioOriginalContractError("WebM contains too many elements")
    const element = elementAt(bytes, offset, end)
    if (element.next <= offset) throw new AudioOriginalContractError("WebM element did not advance")
    result.push(element)
    offset = element.next
  }
  if (offset !== end) throw new AudioOriginalContractError("WebM container is truncated")
  return result
}

function unknownClusterEnd(bytes, start, end, state) {
  const children = []
  let offset = start
  while (offset < end) {
    const id = readVint(bytes, offset, 4, true, "WebM element identifier")
    if (id.value === CLUSTER) return { boundary: offset, children }
    state.count += 1
    if (state.count > MAX_ELEMENTS) throw new AudioOriginalContractError("WebM contains too many elements")
    const child = elementAt(bytes, offset, end)
    if (child.next <= offset) throw new AudioOriginalContractError("WebM element did not advance")
    children.push(child)
    offset = child.next
  }
  if (offset !== end) throw new AudioOriginalContractError("WebM Cluster is truncated")
  return { boundary: end, children }
}

function segmentElements(bytes, start, end, state) {
  const result = []
  let offset = start
  while (offset < end) {
    state.count += 1
    if (state.count > MAX_ELEMENTS) throw new AudioOriginalContractError("WebM contains too many elements")
    let element = elementAt(bytes, offset, end, { allowUnknownSize: true })
    if (element.unknownSize) {
      if (element.id !== CLUSTER) {
        throw new AudioOriginalContractError("Only WebM Cluster may use an unknown size inside Segment")
      }
      const delimited = unknownClusterEnd(bytes, element.dataStart, end, state)
      element = {
        ...element,
        dataEnd: delimited.boundary,
        next: delimited.boundary,
        parsedChildren: delimited.children,
      }
    }
    if (element.next <= offset) throw new AudioOriginalContractError("WebM element did not advance")
    result.push(element)
    offset = element.next
  }
  if (offset !== end) throw new AudioOriginalContractError("WebM Segment is truncated")
  return result
}

function ascii(bytes, start, end) {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] < 0x20 || bytes[index] > 0x7e) {
      throw new AudioOriginalContractError("WebM text metadata is invalid")
    }
  }
  return new TextDecoder("ascii").decode(bytes.subarray(start, end))
}

function unsignedInteger(bytes, start, end, label) {
  const length = end - start
  if (length < 1 || length > 8) throw new AudioOriginalContractError(`${label} is invalid`)
  let value = 0n
  for (let index = start; index < end; index += 1) value = (value << 8n) | BigInt(bytes[index])
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AudioOriginalContractError(`${label} is too large`)
  return Number(value)
}

function requireNonzeroUnsignedInteger(bytes, start, end, label) {
  const length = end - start
  if (length < 1 || length > 8 || !bytes.subarray(start, end).some((value) => value !== 0)) {
    throw new AudioOriginalContractError(`${label} is invalid`)
  }
}

function floatNumber(bytes, start, end, label) {
  const length = end - start
  if (length !== 4 && length !== 8) throw new AudioOriginalContractError(`${label} is invalid`)
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length)
  const value = length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false)
  if (!Number.isFinite(value) || value <= 0) throw new AudioOriginalContractError(`${label} is invalid`)
  return value
}

function opusHeader(bytes, start, end) {
  if (end - start < 19) throw new AudioOriginalContractError("Opus codec private data is truncated")
  if (ascii(bytes, start, start + 8) !== "OpusHead" || bytes[start + 8] !== 1) {
    throw new AudioOriginalContractError("WebM audio track does not contain an OpusHead version 1 header")
  }
  const channels = bytes[start + 9]
  if (channels < 1) throw new AudioOriginalContractError("Opus channel count is invalid")
  const preSkip = bytes[start + 10] | (bytes[start + 11] << 8)
  const inputRate = (bytes[start + 12] | (bytes[start + 13] << 8)
    | (bytes[start + 14] << 16) | (bytes[start + 15] << 24)) >>> 0
  if (inputRate !== 0 && inputRate !== 48_000) {
    throw new AudioOriginalContractError("Opus pre-skip or input sample rate is invalid")
  }
  const mappingFamily = bytes[start + 18]
  if (mappingFamily !== 0 || channels > 2 || end - start !== 19) {
    throw new AudioOriginalContractError("Opus channel mapping is outside the supported mono/stereo profile")
  }
  return { channels, preSkip, inputRate }
}

function uniqueField(fields, id, label) {
  if (fields.has(id)) throw new AudioOriginalContractError(`${label} is duplicated`)
  fields.add(id)
}

function parseAudio(bytes, element, state) {
  const fields = new Set()
  let channels = null
  let samplingFrequency = null
  for (const child of childElements(bytes, element.dataStart, element.dataEnd, state)) {
    uniqueField(fields, child.id, "WebM Audio field")
    if (child.id === SAMPLING_FREQUENCY) {
      samplingFrequency = floatNumber(bytes, child.dataStart, child.dataEnd, "WebM sampling frequency")
    } else if (child.id === OUTPUT_SAMPLING_FREQUENCY) {
      if (floatNumber(bytes, child.dataStart, child.dataEnd, "WebM output sampling frequency") !== 48_000) {
        throw new AudioOriginalContractError("WebM output sampling frequency must be 48000 Hz")
      }
    } else if (child.id === CHANNELS) {
      channels = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM channel count")
    } else if (child.id === BIT_DEPTH) {
      unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM bit depth")
    } else {
      throw new AudioOriginalContractError("WebM Audio contains an unsupported active element")
    }
  }
  if (samplingFrequency !== 48_000 || channels === null) {
    throw new AudioOriginalContractError("WebM Audio must declare 48000 Hz and a channel count")
  }
  return { channels, samplingFrequency }
}

function parseTrackEntry(bytes, entry, state) {
  const fields = new Set()
  let type = null
  let codec = null
  let opus = null
  let audio = null
  let trackNumber = null
  let codecDelay = null
  let seekPreRoll = null
  for (const child of childElements(bytes, entry.dataStart, entry.dataEnd, state)) {
    if (child.id === CRC32) throw new AudioOriginalContractError("CRC-32 elements are not supported")
    if (child.id === VOID) continue
    uniqueField(fields, child.id, "WebM TrackEntry field")
    if (child.id === TRACK_TYPE) {
      type = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM track type")
    } else if (child.id === CODEC_ID) {
      codec = ascii(bytes, child.dataStart, child.dataEnd)
    } else if (child.id === CODEC_PRIVATE) {
      opus = opusHeader(bytes, child.dataStart, child.dataEnd)
    } else if (child.id === TRACK_NUMBER) {
      trackNumber = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM track number")
    } else if (child.id === TRACK_UID) {
      requireNonzeroUnsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM track UID")
    } else if ([FLAG_ENABLED, FLAG_DEFAULT, FLAG_FORCED, FLAG_LACING].includes(child.id)) {
      const flag = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM track flag")
      if (flag !== 0 && flag !== 1) throw new AudioOriginalContractError("WebM track flag is invalid")
      if (child.id === FLAG_LACING && flag !== 0) throw new AudioOriginalContractError("Laced WebM tracks are not supported")
    } else if (child.id === DEFAULT_DURATION) {
      unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM default duration")
    } else if (child.id === TRACK_NAME || child.id === LANGUAGE) {
      ascii(bytes, child.dataStart, child.dataEnd)
    } else if (child.id === CODEC_DELAY) {
      codecDelay = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM codec delay")
    } else if (child.id === SEEK_PRE_ROLL) {
      seekPreRoll = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM seek pre-roll")
    } else if (child.id === AUDIO) {
      audio = parseAudio(bytes, child, state)
    } else {
      throw new AudioOriginalContractError("WebM TrackEntry contains an unsupported active element")
    }
  }
  if (type === 1) throw new AudioOriginalContractError("Video tracks are not supported")
  if (type !== 2 || codec !== "A_OPUS" || !opus || !audio || trackNumber !== 1) {
    throw new AudioOriginalContractError("Every WebM track must be an Opus audio track")
  }
  if (audio.channels !== opus.channels || (opus.inputRate !== 0 && audio.samplingFrequency !== opus.inputRate)) {
    throw new AudioOriginalContractError("WebM Audio metadata does not match OpusHead")
  }
  const expectedDelay = (opus.preSkip * 1_000_000_000) / 48_000
  if (!Number.isInteger(expectedDelay)
    || (codecDelay !== null && codecDelay !== expectedDelay)
    || (seekPreRoll !== null && seekPreRoll !== 80_000_000)) {
    throw new AudioOriginalContractError("WebM Opus codec delay or seek pre-roll is invalid")
  }
  return { channels: opus.channels, trackNumber }
}

function parseInfo(bytes, element, state) {
  const fields = new Set()
  let timecodeScale = 1_000_000
  for (const child of childElements(bytes, element.dataStart, element.dataEnd, state)) {
    if (child.id === CRC32) throw new AudioOriginalContractError("CRC-32 elements are not supported")
    if (child.id === VOID) continue
    uniqueField(fields, child.id, "WebM Info field")
    if (child.id === TIMECODE_SCALE) {
      timecodeScale = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM timecode scale")
      if (timecodeScale < 1 || timecodeScale > 1_000_000_000) {
        throw new AudioOriginalContractError("WebM timecode scale is invalid")
      }
    } else if (child.id === DURATION) {
      floatNumber(bytes, child.dataStart, child.dataEnd, "WebM duration")
    } else if (child.id === MUXING_APP || child.id === WRITING_APP) {
      ascii(bytes, child.dataStart, child.dataEnd)
    } else {
      throw new AudioOriginalContractError("WebM Info contains an unsupported active element")
    }
  }
  return timecodeScale
}

function opusFrameDurationUnits(toc) {
  const configuration = toc >>> 3
  if (configuration < 12) return [4, 8, 16, 24][configuration & 0x03]
  if (configuration < 16) return [4, 8][configuration & 0x01]
  return [1, 2, 4, 8][configuration & 0x03]
}

function opusFrameLength(packet, offset, boundary) {
  if (offset >= boundary) return null
  const first = packet[offset]
  if (first < 252) return { length: first, next: offset + 1 }
  if (offset + 1 >= boundary) return null
  const length = first + (4 * packet[offset + 1])
  return length <= 1275 ? { length, next: offset + 2 } : null
}

function opusPacketValid(packet) {
  if (packet.byteLength < 1) return false
  const code = packet[0] & 0x03
  const payloadLength = packet.byteLength - 1
  const durationUnits = opusFrameDurationUnits(packet[0])
  if (code === 0) return payloadLength <= 1275
  if (code === 1) return durationUnits * 2 <= 48
    && payloadLength % 2 === 0 && payloadLength / 2 <= 1275
  if (code === 2) {
    if (durationUnits * 2 > 48) return false
    const first = opusFrameLength(packet, 1, packet.byteLength)
    if (!first) return false
    const secondLength = packet.byteLength - first.next - first.length
    return secondLength >= 0 && secondLength <= 1275
  }
  if (packet.byteLength < 2) return false
  let offset = 2
  const control = packet[1]
  const frameCount = control & 0x3f
  if (frameCount < 1 || frameCount > 48 || durationUnits * frameCount > 48) return false
  let padding = 0
  if ((control & 0x40) !== 0) {
    for (;;) {
      if (offset >= packet.byteLength) return false
      const amount = packet[offset]
      offset += 1
      padding += amount === 255 ? 254 : amount
      if (amount !== 255) break
    }
  }
  if (padding > packet.byteLength - offset) return false
  const payloadEnd = packet.byteLength - padding
  if ((control & 0x80) === 0) {
    const framedLength = payloadEnd - offset
    return framedLength % frameCount === 0 && framedLength / frameCount <= 1275
  }
  let declared = 0
  for (let frame = 0; frame < frameCount - 1; frame += 1) {
    const parsed = opusFrameLength(packet, offset, payloadEnd)
    if (!parsed) return false
    offset = parsed.next
    declared += parsed.length
    if (declared > payloadEnd - offset) return false
  }
  const lastLength = payloadEnd - offset - declared
  return lastLength >= 0 && lastLength <= 1275
}

function parseSimpleBlock(bytes, element, trackNumber) {
  const track = readVint(bytes, element.dataStart, 8, false, "WebM block track number")
  const header = element.dataStart + track.length
  if (track.unknown || track.value !== trackNumber || header + 3 > element.dataEnd) {
    throw new AudioOriginalContractError("WebM block references an undeclared track")
  }
  const relative = new DataView(bytes.buffer, bytes.byteOffset + header, 2).getInt16(0, false)
  const flags = bytes[header + 2]
  if ((flags & 0x06) !== 0) throw new AudioOriginalContractError("Laced WebM blocks are not supported")
  const packet = bytes.subarray(header + 3, element.dataEnd)
  if (!opusPacketValid(packet)) throw new AudioOriginalContractError("WebM block contains an invalid Opus packet")
  return relative
}

function parseCluster(bytes, element, state, trackNumber, previousAbsolute) {
  let timecode = null
  let blockCount = 0
  let lastAbsolute = previousAbsolute
  const children = element.parsedChildren ?? childElements(bytes, element.dataStart, element.dataEnd, state)
  for (const child of children) {
    if (child.id === CRC32) throw new AudioOriginalContractError("CRC-32 elements are not supported")
    if (child.id === VOID) continue
    if (child.id === CLUSTER_TIMECODE) {
      if (timecode !== null) throw new AudioOriginalContractError("WebM Cluster timecode is duplicated")
      timecode = unsignedInteger(bytes, child.dataStart, child.dataEnd, "WebM Cluster timecode")
    } else if (child.id === SIMPLE_BLOCK) {
      if (timecode === null) throw new AudioOriginalContractError("WebM Cluster timecode must precede blocks")
      const absolute = timecode + parseSimpleBlock(bytes, child, trackNumber)
      if (absolute < 0 || absolute < lastAbsolute) throw new AudioOriginalContractError("WebM block timecodes are not monotonic")
      lastAbsolute = absolute
      blockCount += 1
    } else {
      throw new AudioOriginalContractError("WebM Cluster contains an unsupported active element")
    }
  }
  if (timecode === null || blockCount < 1) throw new AudioOriginalContractError("WebM Cluster contains no playable audio block")
  return lastAbsolute
}

/** Strict byte-level validator for one audio-only WebM containing one Opus track. */
export function inspectWebmOpusAudio(value) {
  const bytes = asBytes(value)
  if (!bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_ORIGINAL_BYTES) {
    throw new AudioOriginalContractError("Choose a WebM/Opus audio file no larger than 20 MiB")
  }
  const state = { count: 1 }
  const header = elementAt(bytes, 0, bytes.byteLength)
  if (header.id !== EBML) throw new AudioOriginalContractError("Audio original is not an EBML WebM file")
  const headerFields = new Map()
  for (const child of childElements(bytes, header.dataStart, header.dataEnd, state)) {
    if (child.id === CRC32) throw new AudioOriginalContractError("CRC-32 elements are not supported")
    if (child.id === VOID) continue
    if (headerFields.has(child.id)) throw new AudioOriginalContractError("EBML header field is duplicated")
    headerFields.set(child.id, child)
  }
  const docType = headerFields.get(DOC_TYPE)
  if (!docType || ascii(bytes, docType.dataStart, docType.dataEnd) !== "webm") {
    throw new AudioOriginalContractError("EBML document type must be WebM")
  }
  const requiredHeaderIntegers = new Map([
    [0x4286, 1], [0x42f7, 1], [0x42f2, 4], [0x42f3, 8],
  ])
  for (const [id, expected] of requiredHeaderIntegers) {
    const field = headerFields.get(id)
    if (!field || unsignedInteger(bytes, field.dataStart, field.dataEnd, "EBML header field") !== expected) {
      throw new AudioOriginalContractError("EBML header version or length profile is unsupported")
    }
  }
  const docTypeVersion = headerFields.get(0x4287)
  const docTypeReadVersion = headerFields.get(0x4285)
  if (!docTypeVersion || !docTypeReadVersion
    || unsignedInteger(bytes, docTypeVersion.dataStart, docTypeVersion.dataEnd, "WebM DocType version") > 4
    || unsignedInteger(bytes, docTypeReadVersion.dataStart, docTypeReadVersion.dataEnd, "WebM DocType read version") > 2
    || headerFields.size !== 7) {
    throw new AudioOriginalContractError("WebM DocType version profile is unsupported")
  }
  if (header.next >= bytes.byteLength) throw new AudioOriginalContractError("WebM segment is missing")
  const segment = elementAt(bytes, header.next, bytes.byteLength, { allowUnknownSize: true })
  if (segment.id !== SEGMENT || (!segment.unknownSize && segment.next !== bytes.byteLength)) {
    throw new AudioOriginalContractError("WebM must contain one complete segment")
  }
  let info = null
  let tracks = null
  const clusters = []
  let sawCluster = false
  for (const child of segmentElements(bytes, segment.dataStart, segment.dataEnd, state)) {
    if (child.id === CRC32) throw new AudioOriginalContractError("CRC-32 elements are not supported")
    if (child.id === VOID) continue
    if (child.id === INFO) {
      if (info || sawCluster) throw new AudioOriginalContractError("WebM Info is duplicated or out of order")
      info = child
    } else if (child.id === TRACKS) {
      if (tracks || sawCluster) throw new AudioOriginalContractError("WebM Tracks is duplicated or out of order")
      tracks = child
    } else if (child.id === CLUSTER) {
      if (!info || !tracks) throw new AudioOriginalContractError("WebM metadata must precede Cluster data")
      sawCluster = true
      clusters.push(child)
    } else {
      throw new AudioOriginalContractError("WebM Segment contains an unsupported active element")
    }
  }
  if (!info || !tracks || clusters.length < 1) throw new AudioOriginalContractError("WebM Info, Tracks, and Cluster are required")
  parseInfo(bytes, info, state)
  const trackChildren = childElements(bytes, tracks.dataStart, tracks.dataEnd, state)
  if (trackChildren.some((item) => item.id !== TRACK_ENTRY && item.id !== VOID)) {
    throw new AudioOriginalContractError("WebM Tracks contains an unsupported active element")
  }
  const entries = trackChildren.filter((item) => item.id === TRACK_ENTRY)
  if (entries.length !== 1) throw new AudioOriginalContractError("WebM must contain exactly one audio track")
  const track = parseTrackEntry(bytes, entries[0], state)
  let previousAbsolute = -1
  for (const cluster of clusters) previousAbsolute = parseCluster(bytes, cluster, state, track.trackNumber, previousAbsolute)
  return Object.freeze({ trackCount: 1, channels: track.channels })
}

export function audioOriginalMediaType(filename, declaredMediaType, value) {
  if (extensionOf(filename) !== ".webm" || baseMediaType(declaredMediaType) !== AUDIO_ORIGINAL_MEDIA_TYPE) {
    throw new AudioOriginalContractError("Audio original extension and media type must be .webm and audio/webm")
  }
  inspectWebmOpusAudio(value)
  return AUDIO_ORIGINAL_MEDIA_TYPE
}

export function createAudioOriginalManifest(value, contentSha256) {
  const bytes = asBytes(value)
  if (!bytes || typeof contentSha256 !== "string" || !SHA256.test(contentSha256)) {
    throw new AudioOriginalContractError("Audio original manifest binding is invalid")
  }
  const inspected = inspectWebmOpusAudio(bytes)
  return Object.freeze({
    schemaId: AUDIO_ORIGINAL_SCHEMA_ID,
    container: "webm",
    codec: "opus",
    mediaType: AUDIO_ORIGINAL_MEDIA_TYPE,
    trackCount: inspected.trackCount,
    channels: inspected.channels,
    byteSize: bytes.byteLength,
    contentSha256,
  })
}

export function normalizeAudioOriginalManifest(value, binding = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== MANIFEST_KEYS.size
    || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))
    || value.schemaId !== AUDIO_ORIGINAL_SCHEMA_ID
    || value.container !== "webm" || value.codec !== "opus"
    || value.mediaType !== AUDIO_ORIGINAL_MEDIA_TYPE
    || value.trackCount !== 1
    || !Number.isSafeInteger(value.channels) || value.channels < 1 || value.channels > 2
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > MAX_AUDIO_ORIGINAL_BYTES
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)) {
    throw new AudioOriginalContractError("Audio original manifest is invalid")
  }
  if (binding.mediaType !== undefined && baseMediaType(binding.mediaType) !== value.mediaType) {
    throw new AudioOriginalContractError("Audio original manifest is bound to a different media type")
  }
  if (binding.byteSize !== undefined && binding.byteSize !== value.byteSize) {
    throw new AudioOriginalContractError("Audio original manifest is bound to a different byte size")
  }
  if (binding.contentSha256 !== undefined && binding.contentSha256 !== value.contentSha256) {
    throw new AudioOriginalContractError("Audio original manifest is bound to a different content hash")
  }
  return Object.freeze({
    schemaId: AUDIO_ORIGINAL_SCHEMA_ID,
    container: "webm",
    codec: "opus",
    mediaType: AUDIO_ORIGINAL_MEDIA_TYPE,
    trackCount: 1,
    channels: value.channels,
    byteSize: value.byteSize,
    contentSha256: value.contentSha256,
  })
}

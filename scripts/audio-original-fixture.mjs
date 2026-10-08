function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function size(value) {
  for (let length = 1; length <= 8; length += 1) {
    if (value < (2 ** (7 * length)) - 1) {
      const bytes = new Uint8Array(length)
      let rest = value
      for (let index = length - 1; index >= 0; index -= 1) {
        bytes[index] = rest & 0xff
        rest = Math.floor(rest / 256)
      }
      bytes[0] |= 1 << (8 - length)
      return bytes
    }
  }
  throw new Error("fixture element too large")
}

function element(id, payload) {
  return concat(Uint8Array.from(id), size(payload.length), payload)
}

function uint(value) {
  const bytes = []
  let rest = value
  do {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  } while (rest > 0)
  return Uint8Array.from(bytes)
}

const ascii = (value) => new TextEncoder().encode(value)
const uintElement = (id, value) => element(id, uint(value))
const asciiElement = (id, value) => element(id, ascii(value))

export function webmOpusFixture({
  channels = 1,
  trackType = 2,
  codecId = "A_OPUS",
  lacing = false,
  includeCluster = true,
  duplicateTrack = false,
  docType = "webm",
  opusMagic = "OpusHead",
  opusPacket = Uint8Array.from([0xf8, 0xff]),
} = {}) {
  const opusHead = new Uint8Array(19)
  opusHead.set(ascii(opusMagic).subarray(0, 8), 0)
  opusHead[8] = 1
  opusHead[9] = channels
  opusHead[10] = 0x38
  opusHead[11] = 0x01
  new DataView(opusHead.buffer).setUint32(12, 48_000, true)
  opusHead[18] = 0
  const frequency = new Uint8Array(8)
  new DataView(frequency.buffer).setFloat64(0, 48_000, false)
  const audio = element([0xe1], concat(
    element([0xb5], frequency),
    uintElement([0x9f], channels),
  ))
  const entry = element([0xae], concat(
    uintElement([0xd7], 1),
    uintElement([0x73, 0xc5], 1),
    uintElement([0x83], trackType),
    uintElement([0x9c], 0),
    asciiElement([0x86], codecId),
    element([0x63, 0xa2], opusHead),
    uintElement([0x56, 0xaa], 6_500_000),
    uintElement([0x56, 0xbb], 80_000_000),
    audio,
  ))
  const tracks = element([0x16, 0x54, 0xae, 0x6b], duplicateTrack ? concat(entry, entry) : entry)
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(
    uintElement([0x2a, 0xd7, 0xb1], 1_000_000),
    asciiElement([0x4d, 0x80], "Galaxy"),
    asciiElement([0x57, 0x41], "Galaxy"),
  ))
  const block = element([0xa3], concat(
    Uint8Array.from([0x81, 0x00, 0x00, lacing ? 0x82 : 0x80]),
    Uint8Array.from(opusPacket),
  ))
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], concat(uintElement([0xe7], 0), block))
  const segment = element([0x18, 0x53, 0x80, 0x67], concat(info, tracks, ...(includeCluster ? [cluster] : [])))
  const header = element([0x1a, 0x45, 0xdf, 0xa3], concat(
    uintElement([0x42, 0x86], 1),
    uintElement([0x42, 0xf7], 1),
    uintElement([0x42, 0xf2], 4),
    uintElement([0x42, 0xf3], 8),
    asciiElement([0x42, 0x82], docType),
    uintElement([0x42, 0x87], 4),
    uintElement([0x42, 0x85], 2),
  ))
  return concat(header, segment)
}

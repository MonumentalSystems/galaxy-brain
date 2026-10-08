const GALAXY_REFERENCE_PATTERN = /^gb:(entity|node):(.+)$/
const MAX_IDENTIFIER_CHARACTERS = 512
const MAX_REFERENCE_CHARACTERS = 8_192

function characterCount(value) {
  return Array.from(value).length
}

export function createGalaxyReference(kind, id) {
  const normalized = id.trim()
  if (!normalized || characterCount(normalized) > MAX_IDENTIFIER_CHARACTERS) {
    throw new Error("Galaxy references require an identifier between 1 and 512 characters")
  }
  return `gb:${kind}:${encodeURIComponent(normalized)}`
}

export function parseGalaxyReference(value) {
  if (!value || value.length > MAX_REFERENCE_CHARACTERS) return null
  const match = GALAXY_REFERENCE_PATTERN.exec(value)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[2]).trim()
    if (!id || characterCount(id) > MAX_IDENTIFIER_CHARACTERS) return null
    return { kind: match[1], id }
  } catch {
    return null
  }
}

export function galaxyReferenceHref(reference, pathname) {
  if (pathname !== "/graph" && pathname !== "/workspace") {
    throw new TypeError("Reference links require an explicit supported destination")
  }
  const params = new URLSearchParams({ ref: reference })
  return `${pathname}?${params.toString()}`
}

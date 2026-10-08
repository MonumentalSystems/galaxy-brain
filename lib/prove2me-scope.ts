import "server-only"

/**
 * Prove2me's API also accepts writes: it can submit proofs, edit theorems, and
 * mint API keys. Galaxy Brain reads decomposition graphs from it, so the proxy
 * forwards reads only. Anything that could act on the user's Prove2me account
 * has to be an explicit, separately reviewed addition rather than something
 * that arrives by default with a catch-all route.
 */

const READ_PATTERNS: RegExp[] = [
  /^missions$/,
  /^missions\/[^/]+\/milestones$/,
  /^milestones\/[^/]+\/history$/,
  /^theorems$/,
  /^theorems\/[^/]+$/,
  /^theorems\/[^/]+\/graph$/,
  /^theorems\/[^/]+\/open-leaves$/,
  /^theorems\/[^/]+\/decompositions$/,
  /^theorems\/[^/]+\/submissions$/,
  /^submissions\/[^/]+\/solution$/,
  /^health$/,
]

/** Rejects traversal and empty segments before the path is matched or joined. */
export function isSafeProve2mePath(path: string[]) {
  if (path.length === 0 || path.length > 8) return false
  return path.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"))
}

export function isAllowedProve2meRead(path: string[]) {
  const joined = path.join("/")
  return READ_PATTERNS.some((pattern) => pattern.test(joined))
}

/**
 * The scope a caller needs to read Prove2me through Galaxy Brain. Human
 * sessions carry "*", so this only constrains agent and service principals.
 */
export const PROVE2ME_READ_SCOPES = ["prove2me:read", "prove2me:*"]

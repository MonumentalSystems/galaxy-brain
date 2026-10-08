import { validateResolvedSurface } from "./surface-resolution-contract.js"

export function surfaceResolutionIdentity(result) {
  if (result?.status !== "resolved" || result.projection?.kind !== "surface") return null
  const projection = result.projection
  const versionMatch = /^version:([1-9][0-9]*)$/u.exec(projection.provenance?.sourceRevision ?? "")
  const version = versionMatch ? Number(versionMatch[1]) : NaN
  const surfaceId = projection.provenance?.sourceId
  const contentHash = projection.revision?.contentHash
  if (
    projection.provenance?.provider !== "galaxy.surface"
    || projection.revision?.policy !== "pinned"
    || typeof surfaceId !== "string"
    || !Number.isSafeInteger(version)
    || typeof contentHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(contentHash)
  ) return null
  return Object.freeze({ surfaceId, version, contentHash })
}

/**
 * Ephemerally materialize exact surface projections. Metadata hydration is
 * already authoritative; failures here therefore retain the exact projection
 * but never attach renderer input.
 */
export async function hydrateAtlasSurfaceSpecs(
  byReference,
  resolveSurface,
  signal,
  concurrency = 3,
) {
  if (!byReference || typeof byReference !== "object" || Array.isArray(byReference)) {
    throw new TypeError("Atlas hydration lookup is required")
  }
  if (typeof resolveSurface !== "function") throw new TypeError("Surface resolver is required")
  const entries = Object.entries(byReference)
  const enriched = { ...byReference }
  const workerCount = Number.isSafeInteger(concurrency)
    ? Math.max(1, Math.min(8, concurrency))
    : 3
  let cursor = 0

  async function worker() {
    while (!signal?.aborted && cursor < entries.length) {
      const index = cursor
      cursor += 1
      const [reference, result] = entries[index]
      const expected = surfaceResolutionIdentity(result)
      if (!expected) continue
      try {
        const resolved = await resolveSurface(expected.surfaceId, expected.version, signal)
        if (signal?.aborted) return
        const validated = validateResolvedSurface(resolved, expected)
        if (!validated) continue
        enriched[reference] = Object.freeze({
          ...result,
          surfaceSpec: validated.materialized_spec,
        })
      } catch {
        // Fail closed to the exact metadata projection.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(workerCount, entries.length) }, () => worker()))
  return Object.freeze(enriched)
}

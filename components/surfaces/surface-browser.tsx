"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CheckCircle2, Clock3, Layers3, LoaderCircle, RefreshCw, Search, ShieldCheck } from "lucide-react"

import { SurfaceRenderer } from "@/components/surfaces/surface-renderer"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { atlasReferenceHandoffHref } from "@/lib/atlas-reference-handoff.js"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import {
  BUILTIN_GENEROUS_SURFACE_RENDERER,
  getSurfaceRenderer,
  isCompatibleSurfaceCatalogDigest,
} from "@/lib/surface-renderer-registry"
import { validRenderableSurfaceSpec, validateResolvedSurface } from "@/lib/surface-resolution-contract.js"
import {
  normalizeSurfacePromotionResponse,
  surfaceHeadMatchesReview,
  surfacePromotionProvenance,
} from "@/lib/surface-promotion.js"
import { promotedSurfaceReference } from "@/lib/surface-placement.js"
import type { GalaxySurfaceContractManifest, GalaxySurfaceRecord, GalaxySurfaceRevision, GalaxySurfaceSpec, ResolvedGalaxySurface } from "@/lib/types/surfaces"
import { projectSurfaceProvenance } from "@/lib/surface-projection"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

function dateTime(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "Unknown time" : parsed.toLocaleString()
}

function shortHash(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}

function authorizedSurfaceContract(value: unknown): GalaxySurfaceContractManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const manifest = value as GalaxySurfaceContractManifest
  if (
    manifest.format !== "galaxy.surface-contract"
    || manifest.manifestVersion !== 1
    || manifest.schema?.id !== BUILTIN_GENEROUS_SURFACE_RENDERER.schema
    || manifest.catalog?.id !== BUILTIN_GENEROUS_SURFACE_RENDERER.catalogId
    || manifest.catalog.version !== BUILTIN_GENEROUS_SURFACE_RENDERER.catalogVersion
    || manifest.catalog.renderer?.id !== BUILTIN_GENEROUS_SURFACE_RENDERER.rendererId
    || manifest.catalog.renderer.version !== BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion
    || manifest.digests?.algorithm !== "sha256"
    || manifest.digests.schema !== BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest
    || manifest.digests.catalog !== BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest
  ) return null
  return manifest
}

function surfaceRecordMatchesContract(surface: GalaxySurfaceRecord, contract: GalaxySurfaceContractManifest) {
  return surface.schema_version === contract.schema.id
    && surface.catalog_id === contract.catalog.id
    && surface.catalog_version === contract.catalog.version
    && surface.schema_digest === contract.digests.schema
    && isCompatibleSurfaceCatalogDigest(surface.catalog_digest)
    && surface.renderer_version === contract.catalog.renderer.version
}

function surfaceRevisionMatchesContract(revision: GalaxySurfaceRevision, contract: GalaxySurfaceContractManifest) {
  return revision.schema_digest === contract.digests.schema
    && isCompatibleSurfaceCatalogDigest(revision.catalog_digest)
    && revision.renderer_version === contract.catalog.renderer.version
}

function authorizedLinkedSurface(
  value: unknown,
  expectedId: string,
  contract: GalaxySurfaceContractManifest,
): GalaxySurfaceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const surface = value as GalaxySurfaceRecord
  if (surface.id !== expectedId || !["draft", "promoted", "archived"].includes(surface.status)
    || surface.schema_version !== "gb.surface.v1"
    || surface.catalog_id !== "generous.a2ui" || surface.catalog_version !== "1"
    || typeof surface.title !== "string" || !surface.title
    || !Number.isSafeInteger(surface.current_version) || surface.current_version < 1
    || typeof surface.current_content_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(surface.current_content_hash)
    || !validRenderableSurfaceSpec(surface.current_spec)
    || !surfaceRecordMatchesContract(surface, contract)) return null
  return surface
}

function authorizedSurfaceRevision(
  value: unknown,
  surface: GalaxySurfaceRecord,
  contract: GalaxySurfaceContractManifest,
): GalaxySurfaceRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const revision = value as GalaxySurfaceRevision
  if (
    !UUID.test(revision.id)
    || revision.tenant_id !== surface.tenant_id
    || revision.surface_id !== surface.id
    || !Number.isSafeInteger(revision.version)
    || revision.version < 1
    || typeof revision.title !== "string"
    || revision.title.length < 1
    || revision.title.length > 512
    || !["draft", "promoted", "archived"].includes(revision.status)
    || !SHA256.test(revision.content_hash)
    || typeof revision.created_by_principal_id !== "string"
    || revision.created_by_principal_id.length < 1
    || revision.created_by_principal_id.length > 512
    || typeof revision.created_at !== "string"
    || revision.created_at.length < 1
    || revision.created_at.length > 256
    || Number.isNaN(Date.parse(revision.created_at))
    || !revision.provenance
    || typeof revision.provenance !== "object"
    || Array.isArray(revision.provenance)
    || !validRenderableSurfaceSpec(revision.spec)
    || !surfaceRevisionMatchesContract(revision, contract)
  ) return null
  return revision
}

function normalizedSurfaceRevisions(
  value: unknown,
  surface: GalaxySurfaceRecord,
  contract: GalaxySurfaceContractManifest,
): GalaxySurfaceRevision[] | null {
  if (!Array.isArray(value) || value.length > 200) return null
  const revisions: GalaxySurfaceRevision[] = []
  const ids = new Set<string>()
  const versions = new Set<number>()
  for (const item of value) {
    const revision = authorizedSurfaceRevision(item, surface, contract)
    if (!revision || ids.has(revision.id) || versions.has(revision.version)) return null
    ids.add(revision.id)
    versions.add(revision.version)
    revisions.push(revision)
  }
  return revisions
}

export function SurfaceBrowser({
  initialSurfaceId,
  initialSurfaceVersion,
  initialSurfaceHash,
  invalidExactLink = false,
  accountMenu,
}: {
  initialSurfaceId?: string
  initialSurfaceVersion?: number
  initialSurfaceHash?: string
  invalidExactLink?: boolean
  accountMenu?: ReactNode
}) {
  const [surfaceContract, setSurfaceContract] = useState<GalaxySurfaceContractManifest | null>(null)
  const [surfaces, setSurfaces] = useState<GalaxySurfaceRecord[]>([])
  const [linkedDraft, setLinkedDraft] = useState<GalaxySurfaceRecord | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<GalaxySurfaceRevision[]>([])
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadingRevisions, setLoadingRevisions] = useState(false)
  const [resolution, setResolution] = useState<ResolvedGalaxySurface | null>(null)
  const [loadingResolution, setLoadingResolution] = useState(false)
  const [resolutionError, setResolutionError] = useState<string | null>(null)
  const [resolutionAttempt, setResolutionAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [exactLinkUnavailable, setExactLinkUnavailable] = useState(false)
  const [exactReviewError, setExactReviewError] = useState<string | null>(null)
  const [dismissedReviewKey, setDismissedReviewKey] = useState<string | null>(null)
  const [loadedReviewKey, setLoadedReviewKey] = useState<string | null>(null)
  const [promotionOpen, setPromotionOpen] = useState(false)
  const [promotionBusy, setPromotionBusy] = useState(false)
  const [promotionError, setPromotionError] = useState<string | null>(null)
  const [promotionNotice, setPromotionNotice] = useState<{ surfaceId: string; advanced: boolean } | null>(null)
  const reviewKey = initialSurfaceId && initialSurfaceVersion && initialSurfaceHash
    ? `${initialSurfaceId}:${initialSurfaceVersion}:${initialSurfaceHash}`
    : null
  const promotionRetry = useRef<{ candidateKey: string; idempotencyKey: string } | null>(null)
  const promotionGeneration = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const selectedVersionRef = useRef<number | null>(null)
  const revisionSurfaceIdRef = useRef<string | null>(null)
  const promotionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const promotionSuccessRef = useRef<HTMLAnchorElement | null>(null)
  const promotionNoticeRef = useRef<HTMLDivElement | null>(null)
  const loadGeneration = useRef(0)

  const exactReviewDismissed = reviewKey !== null && dismissedReviewKey === reviewKey

  useLayoutEffect(() => {
    promotionGeneration.current += 1
    return () => {
      promotionGeneration.current += 1
    }
  }, [reviewKey])

  useEffect(() => {
    promotionGeneration.current += 1
    setPromotionOpen(false)
    setPromotionBusy(false)
    setPromotionError(null)
    setPromotionNotice(null)
  }, [reviewKey])

  useLayoutEffect(() => {
    selectedIdRef.current = selectedId
    selectedVersionRef.current = selectedVersion
  }, [selectedId, selectedVersion])

  const loadSurfaces = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    setExactLinkUnavailable(false)
    if (invalidExactLink) {
      setSurfaces([])
      setLinkedDraft(null)
      setSelectedId(null)
      setRevisions([])
      setSelectedVersion(null)
      setExactReviewError("The exact surface link is invalid.")
      setLoadedReviewKey(reviewKey)
      setLoading(false)
      return
    }
    try {
      const [next, contractResponse] = await Promise.all([
        galaxyBrainAPI.getSurfaces({ status: "promoted", limit: 200 }),
        galaxyBrainAPI.getSurfaceContract(),
      ])
      const contract = authorizedSurfaceContract(contractResponse)
      if (next === null || !contract) throw new Error("Surface API unavailable")
      const compatibleSurfaces = next.flatMap((surface) => (
        surface.status === "promoted" && authorizedLinkedSurface(surface, surface.id, contract) ? [surface] : []
      ))
      let requestedDraft: GalaxySurfaceRecord | null = null
      let requestedDraftUnavailable = false
      if (initialSurfaceId && !compatibleSurfaces.some((surface) => surface.id === initialSurfaceId)) {
        try {
          const exact = await galaxyBrainAPI.getSurface(initialSurfaceId)
          requestedDraft = authorizedLinkedSurface(exact, initialSurfaceId, contract)
          requestedDraftUnavailable = requestedDraft === null
        } catch {
          // A missing or unauthorized deep link must not widen draft discovery
          // or prevent the ordinary promoted-only catalog from loading.
          requestedDraft = null
          requestedDraftUnavailable = true
        }
      }
      if (generation !== loadGeneration.current) return
      setSurfaceContract(contract)
      setSurfaces(compatibleSurfaces)
      setLinkedDraft(requestedDraft)
      setExactLinkUnavailable(requestedDraftUnavailable)
      setLoadedReviewKey(reviewKey)
      setSelectedId((current) => {
        if (initialSurfaceId && (compatibleSurfaces.some((surface) => surface.id === initialSurfaceId)
          || requestedDraft?.id === initialSurfaceId)) return initialSurfaceId
        if (current && (compatibleSurfaces.some((surface) => surface.id === current) || requestedDraft?.id === current)) return current
        return compatibleSurfaces[0]?.id ?? null
      })
    } catch {
      if (generation !== loadGeneration.current) return
      setSurfaceContract(null)
      setLinkedDraft(null)
      setError("Could not load compatible surfaces.")
      setLoadedReviewKey(reviewKey)
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [initialSurfaceId, invalidExactLink, reviewKey])

  useEffect(() => {
    void loadSurfaces()
    return () => { loadGeneration.current += 1 }
  }, [loadSurfaces])

  useEffect(() => {
    if (!selectedId || !surfaceContract) {
      setRevisions([])
      setSelectedVersion(null)
      revisionSurfaceIdRef.current = selectedId
      return
    }
    let cancelled = false
    const sameSurface = revisionSurfaceIdRef.current === selectedId
    const desiredVersion = sameSurface ? selectedVersionRef.current : null
    revisionSurfaceIdRef.current = selectedId
    const selectedSurface = linkedDraft?.id === selectedId
      ? linkedDraft
      : surfaces.find((surface) => surface.id === selectedId) ?? null
    setRevisions([])
    if (!sameSurface) setSelectedVersion(null)
    setExactReviewError(null)
    setLoadingRevisions(true)
    const exactRequested = !exactReviewDismissed && selectedId === initialSurfaceId
      && initialSurfaceVersion && initialSurfaceHash
    const revisionsRequest = exactRequested
      ? galaxyBrainAPI.getSurfaceRevision(selectedId, initialSurfaceVersion)
          .then((revision) => revision ? [revision] : [])
      : galaxyBrainAPI.getSurfaceRevisions(selectedId)
    revisionsRequest
      .then((next) => {
        if (cancelled) return
        if (!selectedSurface) throw new Error("Selected surface is unavailable")
        const compatibleRevisions = normalizedSurfaceRevisions(next, selectedSurface, surfaceContract)
        if (!compatibleRevisions) throw new Error("Surface revision ledger is invalid")
        setRevisions(compatibleRevisions)
        const exactRevision = exactRequested
          ? compatibleRevisions.find((revision) => revision.surface_id === selectedId
            && revision.version === initialSurfaceVersion
            && revision.content_hash === initialSurfaceHash
          )
          : null
        const restoredRevision = !exactRequested && desiredVersion !== null
          ? compatibleRevisions.find((revision) => revision.version === desiredVersion) ?? null
          : null
        setSelectedVersion(exactRevision?.version ?? restoredRevision?.version ?? null)
        if (exactRequested && !exactRevision) {
          setExactReviewError("The exact linked surface revision is unavailable.")
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRevisions([])
          if (exactRequested) {
            setExactReviewError("The exact linked surface revision is unavailable.")
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRevisions(false)
      })
    return () => {
      cancelled = true
    }
  }, [exactReviewDismissed, initialSurfaceHash, initialSurfaceId, initialSurfaceVersion, linkedDraft, selectedId, surfaceContract, surfaces])

  const selectorPending = loadedReviewKey !== reviewKey
  const visibleSurfaces = useMemo(() => (
    selectorPending ? [] : linkedDraft && !surfaces.some((surface) => surface.id === linkedDraft.id)
      ? [linkedDraft, ...surfaces]
      : surfaces
  ), [linkedDraft, selectorPending, surfaces])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return visibleSurfaces
    return visibleSurfaces.filter((surface) =>
      surface.title.toLowerCase().includes(normalized) ||
      surface.current_spec.surfaceUpdate.surfaceId?.toLowerCase().includes(normalized) ||
      surface.current_content_hash.toLowerCase().includes(normalized),
    )
  }, [query, visibleSurfaces])

  const selected = visibleSurfaces.find((surface) => surface.id === selectedId) ?? null
  const selectedRevision = selectedVersion === null
    ? null
    : revisions.find((revision) => revision.surface_id === selectedId && revision.version === selectedVersion) ?? null
  const exactReview = !exactReviewDismissed && selectedId === initialSurfaceId && initialSurfaceVersion !== undefined
    && initialSurfaceHash !== undefined
  const exactRevision = exactReview && selectedRevision?.surface_id === initialSurfaceId
    && selectedRevision.version === initialSurfaceVersion
    && selectedRevision.content_hash === initialSurfaceHash
    && ["draft", "promoted", "archived"].includes(selectedRevision.status)
    && validRenderableSurfaceSpec(selectedRevision.spec)
    && surfaceContract !== null
    && surfaceRevisionMatchesContract(selectedRevision, surfaceContract)
    ? selectedRevision
    : null
  const requestedRevisionUnavailable = selectedVersion !== null && selectedRevision === null
  const previewCompatible = !requestedRevisionUnavailable && surfaceContract !== null && (selectedRevision
    ? surfaceRevisionMatchesContract(selectedRevision, surfaceContract)
    : selected !== null && surfaceRecordMatchesContract(selected, surfaceContract))
  const previewSpec: GalaxySurfaceSpec | null = previewCompatible
    ? (exactReview ? exactRevision?.spec ?? null : selectedRevision?.spec ?? selected?.current_spec ?? null)
    : null
  const previewVersion = selectedRevision?.version ?? selected?.current_version ?? null
  const previewStatus = selectedRevision?.status ?? selected?.status
  const previewHash = selectedRevision?.content_hash ?? selected?.current_content_hash
  const previewProvenance = selectedRevision?.provenance ?? selected?.provenance
  const previewSchemaDigest = selectedRevision?.schema_digest ?? selected?.schema_digest ?? ""
  const previewCatalogDigest = selectedRevision?.catalog_digest ?? selected?.catalog_digest ?? ""
  const previewRendererVersion = selectedRevision?.renderer_version ?? selected?.renderer_version ?? ""
  const requiresResolution = (previewSpec?.bindings.length ?? 0) > 0
  const renderSpec = requiresResolution ? resolution?.materialized_spec ?? null : previewSpec
  const surfaceRenderer = renderSpec ? getSurfaceRenderer(renderSpec) : null
  const promotableDraft = exactRevision?.status === "draft" && surfaceHeadMatchesReview(selected, exactRevision)
    ? exactRevision
    : null
  const atlasPlacementHref = useMemo(() => {
    if (
      !selected
      || selected.status !== "promoted"
      || (selectedVersion !== null && selectedRevision?.version !== selected.current_version)
      || previewVersion !== selected.current_version
      || previewHash !== selected.current_content_hash
    ) return null
    try {
      return atlasReferenceHandoffHref(promotedSurfaceReference(selected))
    } catch {
      return null
    }
  }, [previewHash, previewVersion, selected, selectedRevision?.version, selectedVersion])

  const promoteReviewedDraft = useCallback(async () => {
    if (!selected || !promotableDraft || promotionBusy) return
    const candidateKey = `${selected.id}:${promotableDraft.version}:${promotableDraft.content_hash}`
    const idempotencyKey = promotionRetry.current?.candidateKey === candidateKey
      ? promotionRetry.current.idempotencyKey
      : crypto.randomUUID()
    promotionRetry.current = { candidateKey, idempotencyKey }
    const generation = promotionGeneration.current
    setPromotionBusy(true)
    setPromotionError(null)
    try {
      const result = await galaxyBrainAPI.promoteSurface(selected.id, {
        baseVersion: promotableDraft.version,
        baseContentHash: promotableDraft.content_hash,
        provenance: surfacePromotionProvenance(promotableDraft.provenance),
        idempotencyKey,
      })
      const receipt = normalizeSurfacePromotionResponse(result, promotableDraft)
      const compatibleSurface = surfaceContract
        ? authorizedLinkedSurface(receipt.surface, receipt.surface.id, surfaceContract)
        : null
      if (!compatibleSurface) throw new Error("Promoted surface contract is incompatible")
      if (generation !== promotionGeneration.current) return
      promotionRetry.current = null
      setPromotionOpen(false)
      setDismissedReviewKey(reviewKey)
      const promotedUrl = new URL(window.location.href)
      promotedUrl.searchParams.delete("surface")
      promotedUrl.searchParams.delete("version")
      promotedUrl.searchParams.delete("hash")
      window.history.replaceState(null, "", `${promotedUrl.pathname}${promotedUrl.search}${promotedUrl.hash}`)
      if (selectedIdRef.current !== selected.id) {
        await loadSurfaces()
        return
      }
      setLinkedDraft(null)
      setSurfaces((current) => [compatibleSurface, ...current.filter((surface) => surface.id !== compatibleSurface.id)])
      if (generation !== promotionGeneration.current) return
      setSelectedId(compatibleSurface.id)
      setSelectedVersion(null)
      setPromotionNotice({ surfaceId: compatibleSurface.id, advanced: !receipt.currentIsPromotedRevision })
    } catch {
      if (generation !== promotionGeneration.current) return
      setPromotionError("Promotion could not be confirmed. Retry with the same request, or refresh if the draft changed.")
    } finally {
      if (generation === promotionGeneration.current) setPromotionBusy(false)
    }
  }, [loadSurfaces, promotableDraft, promotionBusy, reviewKey, selected, surfaceContract])

  useEffect(() => {
    if (!selectedId || previewVersion === null || !previewHash || !previewSpec || !requiresResolution) {
      setResolution(null)
      setResolutionError(null)
      setLoadingResolution(false)
      return
    }
    let cancelled = false
    setLoadingResolution(true)
    setResolution(null)
    setResolutionError(null)
    galaxyBrainAPI.resolveSurface(selectedId, selectedVersion ?? undefined)
      .then((next) => {
        if (cancelled) return
        const validated = validateResolvedSurface(next, {
          surfaceId: selectedId,
          version: previewVersion,
          contentHash: previewHash,
          definition: previewSpec,
        })
        if (!validated) throw new Error("Surface resolution did not match the selected revision")
        setResolution(validated)
      })
      .catch(() => {
        if (!cancelled) setResolutionError("Live binding data is unavailable. The unresolved definition has not been rendered.")
      })
      .finally(() => {
        if (!cancelled) setLoadingResolution(false)
    })
    return () => { cancelled = true }
  }, [previewHash, previewSpec, previewVersion, requiresResolution, resolutionAttempt, selectedId, selectedVersion])

  const clearExactSelector = useCallback(() => {
    if (!reviewKey) return
    setDismissedReviewKey(reviewKey)
    setExactLinkUnavailable(false)
    setExactReviewError(null)
    const url = new URL(window.location.href)
    url.searchParams.delete("surface")
    url.searchParams.delete("version")
    url.searchParams.delete("hash")
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [reviewKey])

  const selectSurfaceRevision = useCallback((version: number | null) => {
    if (exactReview) clearExactSelector()
    setSelectedVersion(version)
  }, [clearExactSelector, exactReview])

  const selectSurface = useCallback((surfaceId: string) => {
    clearExactSelector()
    setSelectedId(surfaceId)
    setSelectedVersion(null)
  }, [clearExactSelector])

  return (
    <main className="flex min-h-screen flex-col p-3 text-foreground">
      {/* The back button is gone: the lens rail already moves between surfaces. */}
      <TopRail
        lead={<TopRailTitle>Generous surfaces</TopRailTitle>}
        accountMenu={accountMenu}
        actions={(
          <>
            <Badge variant="outline" className="shrink-0 gap-1.5 bg-white/60 dark:bg-cosmic-950/50">
              <ShieldCheck className="h-3.5 w-3.5 text-galaxy-600" />
              gb.surface.v1
            </Badge>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void loadSurfaces()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </>
        )}
      />
      <div className="app-panel mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col overflow-hidden rounded-[1.5rem]">
        <header className="app-hero border-b border-white/40 px-5 py-4 dark:border-white/10">
          <div className="app-chip mb-2 w-fit">Read-only projection</div>
          <p className="max-w-2xl text-sm text-cosmic-600 dark:text-cosmic-300">
            Browse promoted Generous surfaces, inspect their immutable revisions, and keep provenance visible.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside className="flex min-h-[18rem] flex-col border-b border-cosmic-200/70 bg-cosmic-50/40 dark:border-white/10 dark:bg-cosmic-950/25 lg:border-b-0 lg:border-r">
            <div className="border-b border-cosmic-200/70 p-4 dark:border-white/10">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search promoted surfaces"
                  className="bg-white/70 pl-9 dark:bg-cosmic-950/60"
                />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                {surfaces.length} promoted surface{surfaces.length === 1 ? "" : "s"}
                {linkedDraft ? " · 1 linked surface" : ""}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {loading && surfaces.length === 0 && (
                <div className="space-y-2 p-2" aria-label="Loading surfaces">
                  {[0, 1, 2].map((index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-cosmic-100 dark:bg-white/5" />)}
                </div>
              )}
              {!loading && error && (
                <div role="alert" className="m-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
                  <p className="text-destructive">{error}</p>
                  <Button className="mt-3" variant="outline" size="sm" onClick={() => void loadSurfaces()}>Retry</Button>
                </div>
              )}
              {!loading && !error && filtered.length === 0 && (
                <div className="p-8 text-center">
                  <Layers3 className="mx-auto h-8 w-8 text-cosmic-300 dark:text-cosmic-600" />
                  <p className="mt-3 text-sm font-medium">No promoted surfaces found</p>
                  <p className="mt-1 text-xs text-muted-foreground">Promote a reviewed draft from Generous to make it visible here.</p>
                </div>
              )}
              {filtered.map((surface) => (
                <button
                  key={surface.id}
                  onClick={() => selectSurface(surface.id)}
                  aria-pressed={selectedId === surface.id}
                  className={`mb-1.5 w-full rounded-2xl border p-3.5 text-left transition-colors ${
                    selectedId === surface.id
                      ? "border-galaxy-300 bg-white shadow-sm dark:border-galaxy-700 dark:bg-cosmic-950/70"
                      : "border-transparent hover:border-cosmic-200 hover:bg-white/60 dark:hover:border-white/10 dark:hover:bg-white/5"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 font-display text-sm font-semibold text-cosmic-900 dark:text-white">{surface.title}</p>
                    <span className="shrink-0 rounded-full bg-galaxy-100 px-2 py-0.5 text-[10px] font-semibold text-galaxy-800 dark:bg-galaxy-900/50 dark:text-galaxy-200">
                      {surface.status === "draft" ? "draft · " : ""}v{surface.current_version}
                    </span>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 className="h-3 w-3" />{dateTime(surface.updated_at)}</p>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 overflow-y-auto">
            {selectorPending ? (
              <div className="grid min-h-[30rem] place-items-center p-8 text-center" role="status">
                <div>
                  <LoaderCircle className="mx-auto h-10 w-10 animate-spin text-cosmic-300 dark:text-cosmic-600" />
                  <p className="mt-3 font-medium">Loading the requested surface…</p>
                </div>
              </div>
            ) : exactLinkUnavailable || exactReviewError ? (
              <div className="grid min-h-[30rem] place-items-center p-8 text-center" role="alert">
                <div>
                  <Layers3 className="mx-auto h-10 w-10 text-cosmic-300 dark:text-cosmic-600" />
                  <p className="mt-3 font-medium">{exactReviewError || "The exact linked surface revision is unavailable."}</p>
                  <p className="mt-1 text-xs text-muted-foreground">The mutable surface head was not substituted.</p>
                </div>
              </div>
            ) : !selected || !previewSpec ? (
              <div className="grid min-h-[30rem] place-items-center p-8 text-center">
                <div>
                  <Layers3 className="mx-auto h-10 w-10 text-cosmic-300 dark:text-cosmic-600" />
                  <p className="mt-3 font-medium">{exactReview && loadingRevisions
                    ? "Loading the exact surface revision…"
                    : "Select a surface to inspect it."}</p>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-6xl p-5 lg:p-8">
                <div className="mb-6 flex flex-col gap-4 border-b border-cosmic-200/70 pb-5 dark:border-white/10 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge className="bg-galaxy-600">{previewStatus}</Badge>
                      <Badge variant="outline">revision {previewVersion}</Badge>
                      {selectedRevision && <Badge variant="secondary">{exactReview ? "exact revision" : "historical preview"}</Badge>}
                    </div>
                    <h2 className="font-display text-3xl font-semibold tracking-tight text-cosmic-950 dark:text-white">{selectedRevision?.title ?? selected.title}</h2>
                    <p className="mt-2 font-mono text-xs text-muted-foreground" title={previewHash}>{shortHash(previewHash ?? "")}</p>
                    {atlasPlacementHref ? (
                      <Button asChild className="mt-4" size="sm">
                        <a href={atlasPlacementHref}>Place exact surface on Atlas</a>
                      </Button>
                    ) : null}
                  </div>
                  <div className="min-w-0 xl:max-w-lg">
                    {exactReview && exactRevision && (
                      <div className="mb-4 flex flex-col items-start gap-2 rounded-2xl border border-galaxy-200 bg-galaxy-50/70 p-3 dark:border-galaxy-800 dark:bg-galaxy-950/30">
                        <p className="text-xs text-cosmic-700 dark:text-cosmic-200">
                          {exactRevision.status === "draft"
                            ? (promotableDraft
                              ? "This exact draft revision is ready for explicit promotion. Promotion makes it discoverable and placeable; it does not place it automatically."
                              : "This exact draft remains readable, but it is no longer the current draft head and cannot be promoted from this link.")
                            : `Viewing the exact ${exactRevision.status} revision. This immutable revision is read-only and cannot be promoted.`}
                        </p>
                        {exactRevision.status === "draft" ? (
                          <Button
                            ref={promotionTriggerRef}
                            size="sm"
                            disabled={!promotableDraft || promotionBusy}
                            onClick={() => {
                              setPromotionError(null)
                              setPromotionOpen(true)
                            }}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            Promote reviewed revision
                          </Button>
                        ) : null}
                        {exactRevision.status === "draft" && promotionError ? <p role="alert" className="text-xs text-destructive">{promotionError}</p> : null}
                      </div>
                    )}
                    {promotionNotice?.surfaceId === selected.id && (
                      <div ref={promotionNoticeRef} role="status" tabIndex={-1} className="mb-4 rounded-2xl border border-galaxy-300 bg-galaxy-50/70 p-3 text-xs text-cosmic-900 outline-none focus-visible:ring-2 focus-visible:ring-galaxy-500 dark:border-galaxy-700 dark:bg-galaxy-950/30 dark:text-cosmic-100">
                        <p className="font-semibold">Promoted revision confirmed.</p>
                        {promotionNotice.advanced ? (
                          <p className="mt-1">The surface head has changed since that promotion. The latest authorized state has been reloaded.</p>
                        ) : (
                          <>
                            <p className="mt-1">This surface is now discoverable. Open Atlas and choose <strong>Place promoted Generous surface</strong> to position it.</p>
                            <Button asChild size="sm" variant="outline" className="mt-3">
                              <a ref={promotionSuccessRef} href="/workspace">Open Atlas</a>
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-cosmic-500">Revision ledger</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant={selectedVersion === null ? "default" : "outline"} size="sm" onClick={() => selectSurfaceRevision(null)}>
                        Current v{selected.current_version}
                      </Button>
                      {revisions.filter((revision) => revision.version !== selected.current_version).map((revision) => (
                        <Button
                          key={revision.id}
                          variant={selectedVersion === revision.version ? "secondary" : "outline"}
                          size="sm"
                          onClick={() => selectSurfaceRevision(revision.version)}
                          title={`${revision.status} · ${dateTime(revision.created_at)}`}
                        >
                          v{revision.version}
                        </Button>
                      ))}
                      {loadingRevisions && <span className="self-center text-xs text-muted-foreground">Loading…</span>}
                    </div>
                  </div>
                </div>

                {loadingResolution && requiresResolution ? (
                  <div role="status" className="rounded-2xl border border-cosmic-200/70 bg-cosmic-50/60 p-5 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
                    Resolving live bindings before rendering…
                  </div>
                ) : resolutionError && requiresResolution ? (
                  <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
                    <p className="font-medium text-destructive">Live data could not be resolved.</p>
                    <p className="mt-1 text-sm text-muted-foreground">{resolutionError}</p>
                    <Button className="mt-3" variant="outline" size="sm" onClick={() => setResolutionAttempt((attempt) => attempt + 1)}>Retry resolution</Button>
                  </div>
                ) : surfaceRenderer?.implementationId === "builtin.surface-renderer.generous-a2ui" && renderSpec ? (
                  <SurfaceRenderer spec={renderSpec} />
                ) : renderSpec ? (
                  <div role="status" className="rounded-2xl border border-cosmic-200/70 bg-cosmic-50/60 p-5 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
                    This surface has no registered renderer. Its immutable record remains available below.
                  </div>
                ) : null}

                {requiresResolution && (
                  <section className="mt-6 rounded-2xl border border-cosmic-200/70 bg-white/50 p-4 dark:border-white/10 dark:bg-white/5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium">Live binding projection</h3>
                      <Badge variant={resolutionError ? "destructive" : "outline"}>{loadingResolution ? "resolving" : resolution?.resolved_at ? dateTime(resolution.resolved_at) : "unavailable"}</Badge>
                    </div>
                    {resolutionError && <p className="mt-3 text-sm text-destructive">Resolution failed; no unresolved definition is displayed as live data.</p>}
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {resolution?.bindings.map((binding) => (
                        <div key={binding.binding_id} className="rounded-xl border border-cosmic-200/70 p-3 text-xs dark:border-white/10">
                          <div className="flex items-center justify-between gap-2"><span className="font-mono">{binding.binding_id}</span><Badge variant={binding.status === "resolved" ? "secondary" : "destructive"}>{binding.status}</Badge></div>
                          <p className="mt-1 text-muted-foreground">{binding.source_kind} → {binding.target.componentId}.{binding.target.prop}</p>
                          {binding.error && <p className="mt-2 text-destructive">This binding could not be resolved.</p>}
                          {binding.source_ids?.length ? <p className="mt-2 text-muted-foreground">{binding.source_ids.length} canonical source{binding.source_ids.length === 1 ? "" : "s"}</p> : null}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <details className="mt-6 rounded-2xl border border-cosmic-200/70 bg-cosmic-50/60 p-4 dark:border-white/10 dark:bg-white/5">
                  <summary className="cursor-pointer text-sm font-medium">Provenance and immutable record</summary>
                  <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                    <div><dt className="text-muted-foreground">Surface ID</dt><dd className="mt-1 break-all font-mono">{selected.id}</dd></div>
                    <div><dt className="text-muted-foreground">Catalog</dt><dd className="mt-1 font-mono">{selected.catalog_id}@{selected.catalog_version}</dd></div>
                    <div><dt className="text-muted-foreground">Schema digest</dt><dd className="mt-1 font-mono" title={previewSchemaDigest}>{shortHash(previewSchemaDigest)}</dd></div>
                    <div><dt className="text-muted-foreground">Catalog digest</dt><dd className="mt-1 font-mono" title={previewCatalogDigest}>{shortHash(previewCatalogDigest)}</dd></div>
                    <div><dt className="text-muted-foreground">Renderer</dt><dd className="mt-1 break-all font-mono">{previewRendererVersion}</dd></div>
                    <div><dt className="text-muted-foreground">Created</dt><dd className="mt-1">{dateTime(selected.created_at)}</dd></div>
                    <div><dt className="text-muted-foreground">Updated</dt><dd className="mt-1">{dateTime(selected.updated_at)}</dd></div>
                  </dl>
                  <pre className="mt-4 max-h-64 overflow-auto rounded-xl bg-cosmic-950 p-3 text-[11px] leading-5 text-cosmic-100">{JSON.stringify(projectSurfaceProvenance(previewProvenance), null, 2)}</pre>
                </details>
              </div>
            )}
          </section>
        </div>
      </div>
      <AlertDialog open={promotionOpen} onOpenChange={(open) => {
        if (!promotionBusy) setPromotionOpen(open)
      }}>
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault()
          queueMicrotask(() => {
            if (promotionSuccessRef.current) promotionSuccessRef.current.focus()
            else if (promotionNoticeRef.current) promotionNoticeRef.current.focus()
            else promotionTriggerRef.current?.focus()
          })
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle className="research-display text-2xl">Promote this exact surface revision?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                This changes the reviewed draft into a canonical promoted surface. It will become discoverable and eligible for Atlas placement.
              </span>
              <span className="block font-mono text-xs">
                revision {promotableDraft?.version ?? "—"} · {shortHash(promotableDraft?.content_hash ?? "")}
              </span>
              <span className="block">Promotion does not place the surface, execute anything, or publish it outside this tenant.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {promotionError && <p role="alert" className="text-sm text-destructive">{promotionError}</p>}
          <AlertDialogFooter aria-busy={promotionBusy}>
            <AlertDialogCancel disabled={promotionBusy}>Keep as draft</AlertDialogCancel>
            <AlertDialogAction
              disabled={!promotableDraft || promotionBusy}
              onClick={(event) => {
                event.preventDefault()
                void promoteReviewedDraft()
              }}
            >
              {promotionBusy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              {promotionBusy ? "Promoting…" : "Promote exact revision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

"use client"

import { FileJson, Loader2, PackageOpen, Upload } from "lucide-react"
import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react"

import { Button } from "@/components/ui/button"
import { FORMAL_PROJECT_PACKAGE_LIMITS } from "@/lib/formal-project-package.js"
import {
  formalProjectPackageErrorMessage,
  normalizeFormalProjectPackageSummary,
  readFormalProjectPackageResponse,
  type FormalProjectPackageReview,
  type FormalProjectPackageSummary,
} from "@/lib/formal-project-package-client.js"
import {
  FORMAL_PROJECT_PACKAGE_MEDIA_TYPE,
} from "@/lib/formal-project-package-envelope.js"
import { getCanonicalNostrRequestTarget, signNostrHttpRequest } from "@/lib/nostr-browser"

const IMPORT_PATH = "/api/eln/formal-project-packages"

type FileRole = "manifestBytes" | "authoredConceptualDagBytes"
  | "repositoryFieldDagBytes" | "correspondenceBytes"
type SelectedFile = Readonly<{ name: string; size: number; bytes: Uint8Array }>
type SelectedFiles = Partial<Record<FileRole, SelectedFile>>
type Review = Readonly<{
  generation: number
  files: Readonly<Record<FileRole, SelectedFile>>
  expected: FormalProjectPackageReview
  envelopeBytes: Uint8Array
}>
type WorkerResult = {
  requestId: number
  ok: boolean
  envelope?: ArrayBuffer
  review?: FormalProjectPackageReview
  error?: string
}

const FILE_FIELDS: readonly Readonly<{
  role: FileRole
  label: string
  hint: string
  maximum: number
}>[] = [
  {
    role: "manifestBytes",
    label: "Manifest",
    hint: "rosetta.formal-project-package.v1",
    maximum: FORMAL_PROJECT_PACKAGE_LIMITS.manifestBytes,
  },
  {
    role: "authoredConceptualDagBytes",
    label: "Authored conceptual DAG",
    hint: "Raw Rosetta conceptual structure",
    maximum: FORMAL_PROJECT_PACKAGE_LIMITS.artifactBytes,
  },
  {
    role: "repositoryFieldDagBytes",
    label: "Repository-field DAG",
    hint: "Passive Galaxy projection",
    maximum: FORMAL_PROJECT_PACKAGE_LIMITS.artifactBytes,
  },
  {
    role: "correspondenceBytes",
    label: "Correspondence",
    hint: "Authored-to-formal mappings",
    maximum: FORMAL_PROJECT_PACKAGE_LIMITS.artifactBytes,
  },
]

export interface FormalProjectPackageImportProps {
  disabled?: boolean
  completionMode?: "registry-selection" | "atlas-placement"
  onImportingChange?: (importing: boolean) => void
  selectionContext: string
  onImported: (
    summary: FormalProjectPackageSummary,
    signal: AbortSignal,
    selectionContext: string,
  ) => Promise<"selected" | "preserved" | "failed">
}

function exactFiles(value: SelectedFiles): Record<FileRole, SelectedFile> | null {
  const result = {} as Record<FileRole, SelectedFile>
  for (const field of FILE_FIELDS) {
    const selected = value[field.role]
    if (!selected) return null
    result[field.role] = selected
  }
  return result
}

export function FormalProjectPackageImport({
  disabled = false,
  completionMode = "registry-selection",
  onImportingChange,
  selectionContext,
  onImported,
}: FormalProjectPackageImportProps) {
  const filesRef = useRef<SelectedFiles>({})
  const roleReadGeneration = useRef<Record<FileRole, number>>({
    manifestBytes: 0,
    authoredConceptualDagBytes: 0,
    repositoryFieldDagBytes: 0,
    correspondenceBytes: 0,
  })
  const reviewGeneration = useRef(0)
  const operationGeneration = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
  const [files, setFiles] = useState<SelectedFiles>({})
  const [review, setReview] = useState<Review | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("Choose exactly one local file for each package role.")

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      reviewGeneration.current += 1
      operationGeneration.current += 1
      workerRef.current?.terminate()
      requestControllerRef.current?.abort()
    }
  }, [])

  const validate = (snapshot: SelectedFiles, generation: number) => {
    const complete = exactFiles(snapshot)
    setReview(null)
    setError("")
    if (!complete) {
      const count = Object.keys(snapshot).length
      setReviewing(false)
      setStatus(`${count} of 4 package files selected.`)
      return
    }
    setReviewing(true)
    setStatus("Validating hashes, identities, and one-to-one cross-bindings.")
    workerRef.current?.terminate()
    const worker = new Worker(
      new URL("../../workers/formal-project-package.worker.ts", import.meta.url),
      { type: "module" },
    )
    workerRef.current = worker
    const transferred = Object.fromEntries(FILE_FIELDS.map(({ role }) => [
      role,
      complete[role].bytes.slice().buffer as ArrayBuffer,
    ])) as Record<FileRole, ArrayBuffer>
    worker.addEventListener("message", (event: MessageEvent<WorkerResult>) => {
      if (event.data?.requestId !== generation) return
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      if (!mountedRef.current || generation !== reviewGeneration.current) return
      setReviewing(false)
      if (!event.data.ok || !event.data.review || !event.data.envelope) {
        setError(event.data.error || "The four files do not form a valid package.")
        setStatus("")
        return
      }
      setReview(Object.freeze({
        generation,
        files: Object.freeze({ ...complete }),
        expected: event.data.review,
        envelopeBytes: new Uint8Array(event.data.envelope),
      }))
      setStatus("Package is valid and ready for explicit import review.")
    })
    worker.addEventListener("error", () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      if (!mountedRef.current || generation !== reviewGeneration.current) return
      setReviewing(false)
      setError("Package validation could not complete. Re-select any file to retry.")
      setStatus("")
    })
    worker.postMessage({ requestId: generation, files: transferred }, Object.values(transferred))
  }

  const selectFile = async (role: FileRole, maximum: number, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const readGeneration = ++roleReadGeneration.current[role]
    requestControllerRef.current?.abort()
    operationGeneration.current += 1
    setReview(null)
    setError("")
    setStatus(`Reading exact bytes from ${file.name}.`)
    try {
      if (file.size < 1 || file.size > maximum) {
        throw new Error(`${file.name} must contain 1 to ${maximum.toLocaleString()} bytes.`)
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (readGeneration !== roleReadGeneration.current[role]) return
      if (bytes.byteLength !== file.size) throw new Error(`${file.name} could not be read completely.`)
      const next = {
        ...filesRef.current,
        [role]: Object.freeze({ name: file.name, size: bytes.byteLength, bytes }),
      }
      filesRef.current = next
      setFiles(next)
      const generation = ++reviewGeneration.current
      validate(next, generation)
    } catch (cause) {
      if (readGeneration !== roleReadGeneration.current[role]) return
      const next = { ...filesRef.current }
      delete next[role]
      filesRef.current = next
      setFiles(next)
      reviewGeneration.current += 1
      setReviewing(false)
      setError(cause instanceof Error ? cause.message : `Unable to read ${file.name}.`)
      setStatus("")
    } finally {
      input.value = ""
    }
  }

  const importPackage = async () => {
    if (!review || review.generation !== reviewGeneration.current) return
    const approvedReview = review
    const approvedSelectionContext = selectionContext
    const body = approvedReview.envelopeBytes.slice()
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    const operation = ++operationGeneration.current
    const isCurrent = () => mountedRef.current
      && operation === operationGeneration.current
      && !controller.signal.aborted
    setImporting(true)
    onImportingChange?.(true)
    setError("")
    setStatus("Requesting a fresh Nostr signature for the reviewed exact envelope.")
    let committed = false
    try {
      const signingUrl = await getCanonicalNostrRequestTarget(IMPORT_PATH)
      if (!isCurrent()) return
      const authorization = await signNostrHttpRequest({
        url: signingUrl,
        method: "POST",
        body,
      })
      if (approvedReview.generation !== reviewGeneration.current) {
        throw new Error("Package files changed after review. Review the current four files before importing.")
      }
      if (!isCurrent()) return
      const response = await fetch(IMPORT_PATH, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": FORMAL_PROJECT_PACKAGE_MEDIA_TYPE,
        },
        body: body.slice().buffer,
        signal: controller.signal,
      })
      committed = response.ok
      let responseValue: unknown = null
      try {
        responseValue = await readFormalProjectPackageResponse(response)
      } catch {
        if (response.ok) throw new Error("The formal project package response was invalid.")
      }
      if (!isCurrent()) return
      if (!response.ok) {
        throw new Error(formalProjectPackageErrorMessage(response.status))
      }
      const summary = normalizeFormalProjectPackageSummary(responseValue, approvedReview.expected)
      if (!isCurrent() || approvedReview.generation !== reviewGeneration.current) return
      const completion = await onImported(summary, controller.signal, approvedSelectionContext)
      if (!isCurrent()) return
      if (completion === "failed") {
        setError(completionMode === "atlas-placement"
          ? "The package was imported, but placement is unconfirmed. Retry placement below without importing again."
          : "The package was imported, but its exact passive proof graph could not be selected. Refresh the proof graph registry manually.")
        setStatus("")
        return
      }
      setStatus(completionMode === "atlas-placement"
        ? "Formal project package imported. Placing its exact passive proof graph on this Atlas."
        : completion === "selected"
        ? summary.replayed
          ? "Those exact package bytes were already registered. The returned passive proof graph is selected."
          : "Formal project package imported. The returned passive proof graph is selected."
        : "Formal project package imported and the registry refreshed. Your newer proof graph selection was preserved.")
    } catch (cause) {
      if (!isCurrent() || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(committed
        ? "The package was imported, but the registry refresh or selection failed. Refresh the proof graph registry manually."
        : cause instanceof Error ? cause.message : "The formal project package could not be imported.")
      setStatus("")
    } finally {
      if (isCurrent()) setImporting(false)
      if (isCurrent()) onImportingChange?.(false)
      if (requestControllerRef.current === controller) requestControllerRef.current = null
    }
  }

  const busy = disabled || reviewing || importing

  return (
    <details className="rounded-xl border border-[#355f49]/15 bg-[#fffdf6]/80 p-3">
      <summary className="cursor-pointer text-sm font-semibold">Import a Rosetta formal project package</summary>
      <div className="mt-3 grid gap-3" aria-busy={reviewing || importing}>
        <p className="text-xs leading-5 text-[#557060]">
          Select the manifest, authored conceptual DAG, passive repository-field DAG, and correspondence as four local files. Galaxy validates their exact bytes before import.
        </p>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Formal project package files</legend>
          {FILE_FIELDS.map((field) => {
            const selected = files[field.role]
            const id = `formal-project-package-${field.role}`
            return <label key={field.role} htmlFor={id} className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-[#355f49]/30 px-3 py-2 hover:bg-[#e9ead9]/70 focus-within:ring-2 focus-within:ring-[#b66238]">
              <FileJson className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 text-xs">
                <span className="block font-semibold text-[#193729]">{field.label}</span>
                <span className="block truncate text-[#557060]">{selected ? `${selected.name} · ${selected.size.toLocaleString()} bytes` : field.hint}</span>
              </span>
              <input id={id} className="sr-only" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void selectFile(field.role, field.maximum, event)} />
            </label>
          })}
        </fieldset>

        {review ? <div className="rounded-xl border border-[#355f49]/20 bg-[#e9ead9]/45 p-3">
          <div className="flex items-center gap-2"><PackageOpen className="size-4" aria-hidden="true" /><p className="font-serif font-semibold">Review immutable package</p></div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-[#557060]">Project</dt><dd className="truncate font-medium">{review.expected.projectId}</dd>
            <dt className="text-[#557060]">Repository</dt><dd className="truncate font-medium">{review.expected.repository}</dd>
            <dt className="text-[#557060]">Commit</dt><dd className="truncate font-mono" title={review.expected.commit}>{review.expected.commit}</dd>
            <dt className="text-[#557060]">Manifest</dt><dd className="break-all font-mono text-[10px]">sha256:{review.expected.manifestSha256}</dd>
            <dt className="text-[#557060]">Authored DAG</dt><dd className="break-all font-mono text-[10px]">sha256:{review.expected.artifacts.authoredConceptualDag.sha256}</dd>
            <dt className="text-[#557060]">Repository field</dt><dd className="break-all font-mono text-[10px]">sha256:{review.expected.repositoryFieldDagSha256}</dd>
            <dt className="text-[#557060]">Correspondence</dt><dd className="break-all font-mono text-[10px]">sha256:{review.expected.artifacts.correspondence.sha256}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#355f49]/15 pt-3">
            <p className="max-w-xl text-xs leading-5 text-[#557060]">Import registers immutable package records and selects its passive proof graph. It creates no mission, workspace, claim, run, or verification state.</p>
            <Button type="button" size="sm" disabled={busy || review.generation !== reviewGeneration.current} onClick={() => void importPackage()}>
              {importing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Upload className="size-4" aria-hidden="true" />}
              {importing ? "Importing…" : "Sign & import exact package"}
            </Button>
          </div>
        </div> : null}

        {error ? <p className="rounded-lg border border-red-800/25 bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p> : null}
        <p className="min-h-5 text-xs text-[#557060]" role="status" aria-live="polite">{(reviewing || importing) && <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden="true" />}{status}</p>
      </div>
    </details>
  )
}

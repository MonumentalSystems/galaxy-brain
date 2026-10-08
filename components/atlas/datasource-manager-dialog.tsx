"use client"

import { Database, FileText, Loader2, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  DATASOURCE_FILE_INGESTION_PLAN_ID,
  datasourceDurableImportUnavailableReason,
  datasourceFileIngestionRegistered,
  datasourceImportFilename,
  datasourceImportTitle,
  datasourceSourceUri,
} from "@/lib/datasource-durable-import"
import { createDocumentTransformClient } from "@/lib/document-transform-client"
import {
  GalaxyBrainAPIError,
  galaxyBrainAPI,
  type ConfirmedDocumentImport,
} from "@/lib/galaxy-brain-api"
import {
  executeIngestionPlan,
  IngestionPlanContractError,
  type IngestionPlanExecutionResult,
} from "@/lib/plugins/ingestion-plans"
import type {
  DatasourceConnection,
  DatasourceItem,
  DatasourcePluginManifest,
} from "@/lib/types/datasources"

type DatasourceImportPhase = "idle" | "reading" | "importing" | "transforming" | "placing"

type ImportDraft = {
  connection: DatasourceConnection
  item: DatasourceItem
  file: File
  confirmation: ConfirmedDocumentImport | null
  target: Readonly<{ workspaceId: string; canvasId: string }>
  ingestionNotice: string
}

export type DatasourceManagerDialogProps = {
  open: boolean
  placementError: string
  placementBusy: boolean
  ingestionScopePrefix: string | null
  ingestionTarget: Readonly<{ workspaceId: string; canvasId: string }> | null
  onOpenChange: (open: boolean) => void
  onDurableImport: (
    confirmation: ConfirmedDocumentImport,
    target: Readonly<{ workspaceId: string; canvasId: string }>,
    ingestionNotice: string,
    ingestionResult: IngestionPlanExecutionResult | null,
  ) => boolean
  returnFocus: HTMLElement | null
}

function safeDatasourceError(action: "load" | "connect" | "browse" | "sync" | "read" | "import", error: unknown) {
  const status = error instanceof GalaxyBrainAPIError ? error.status : 0
  if (status === 401 || status === 403) {
    return action === "connect"
      ? "This server path is not authorized for your tenant, or your sign-in expired."
      : "Sign in again or ask the tenant operator to authorize this datasource."
  }
  if (status === 404) return "That datasource or file is no longer available. Refresh the connection list."
  if (status === 409) return "The exact source changed during import. Browse again before retrying."
  if (status === 413) return "That file exceeds the 100 MB durable import limit."
  if (status === 415 || status === 422) return "This item cannot enter the durable document store in its current format."
  if (action === "load") return "Datasource connections could not be loaded. Retry when the Galaxy API is available."
  if (action === "connect") return "The connection could not be created. Check the approved server path and retry."
  if (action === "browse") return "The datasource could not be browsed. Confirm that its server path is still available."
  if (action === "sync") return "The explicit scan could not be completed. No files were deleted or imported."
  if (action === "read") return "The exact source bytes could not be read. No durable document was created."
  return "The durable import outcome is unconfirmed. Retry with the preserved exact file."
}

function datasourceIngestionOutcomeMessage(result: IngestionPlanExecutionResult) {
  if (result.status === "transforming") {
    return "The exact source is durable. Bounded document analysis is still running."
  }
  if (result.status === "persisted") {
    return result.derivation.retryable
      ? "The exact source is durable. Its derived representation is temporarily unavailable."
      : "The exact source is durable. Derived representation failed without changing the original."
  }
  if (result.derivation.receiptStatus === "fallback") {
    return "The exact source is durable. The registered fallback produced a usable representation."
  }
  if (result.derivation.receiptStatus === "partial") {
    return "The exact source is durable. Analysis produced an explicitly partial representation."
  }
  return "The exact source and its derived document representation are durable."
}

export function DatasourceManagerDialog({
  open,
  placementError,
  placementBusy,
  ingestionScopePrefix,
  ingestionTarget,
  onOpenChange,
  onDurableImport,
  returnFocus,
}: DatasourceManagerDialogProps) {
  const [plugins, setPlugins] = useState<DatasourcePluginManifest[]>([])
  const [connections, setConnections] = useState<DatasourceConnection[]>([])
  const [itemsByConnection, setItemsByConnection] = useState<Record<string, DatasourceItem[]>>({})
  const [selectedPluginId, setSelectedPluginId] = useState("")
  const [connectionName, setConnectionName] = useState("My research vault")
  const [rootPath, setRootPath] = useState("")
  const [loading, setLoading] = useState(false)
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [browsingId, setBrowsingId] = useState<string | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [importPhase, setImportPhase] = useState<DatasourceImportPhase>("idle")
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [abandonOpen, setAbandonOpen] = useState(false)
  const generationRef = useRef(0)
  const initialFocusPendingRef = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const pluginRef = useRef<HTMLSelectElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  const busy = loading || saving || browsingId !== null || syncingId !== null || importPhase !== "idle" || placementBusy
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) || null

  const refresh = useCallback(async () => {
    const generation = generationRef.current
    setLoading(true)
    setError("")
    setStatus("Loading datasource plugins and connections…")
    try {
      const [nextPlugins, nextConnections] = await Promise.all([
        galaxyBrainAPI.getDatasourcePlugins(),
        galaxyBrainAPI.getDatasourceConnections(),
      ])
      if (generation !== generationRef.current) return
      setPlugins(nextPlugins)
      setConnections(nextConnections)
      setSelectedPluginId((current) => nextPlugins.some((plugin) => plugin.id === current)
        ? current
        : nextPlugins[0]?.id || "")
      setStatus(`${nextConnections.length} datasource connection${nextConnections.length === 1 ? "" : "s"} ready.`)
    } catch (cause) {
      if (generation !== generationRef.current) return
      setError(safeDatasourceError("load", cause))
      setStatus("")
    } finally {
      if (generation === generationRef.current) {
        setLoading(false)
        setInitialLoadComplete(true)
      }
    }
  }, [])

  useEffect(() => {
    if (!open) {
      generationRef.current += 1
      initialFocusPendingRef.current = false
      setInitialLoadComplete(false)
      setItemsByConnection({})
      setImportDraft(null)
      setImportPhase("idle")
      setError("")
      setStatus("")
      setAbandonOpen(false)
      return
    }
    generationRef.current += 1
    initialFocusPendingRef.current = true
    setInitialLoadComplete(false)
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open || !initialLoadComplete || loading || !initialFocusPendingRef.current) return
    initialFocusPendingRef.current = false
    const frame = window.requestAnimationFrame(() => {
      if (pluginRef.current && !pluginRef.current.disabled) pluginRef.current.focus()
      else refreshRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [initialLoadComplete, loading, open])

  useEffect(() => {
    if (!placementError || !importDraft?.confirmation) return
    setError(placementError)
    setStatus("")
    setImportPhase("idle")
  }, [importDraft?.confirmation, placementError])

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = connectionName.trim()
    const path = rootPath.trim()
    if (!selectedPlugin || selectedPlugin.id !== "filesystem-vault") {
      setError("Atlas currently supports only the server-owned filesystem vault connector.")
      return
    }
    if (!name || Array.from(name).length > 200) {
      setError("Enter a connection name between 1 and 200 characters.")
      nameRef.current?.focus()
      return
    }
    if (!path || Array.from(path).length > 2_048) {
      setError("Enter an approved server folder path no longer than 2,048 characters.")
      return
    }
    setSaving(true)
    setError("")
    setStatus("Authorizing and creating the datasource connection…")
    try {
      const created = await galaxyBrainAPI.createDatasourceConnection({
        plugin_id: selectedPlugin.id,
        display_name: name,
        root_path: path,
        config: {},
      })
      if (!created) throw new Error("missing connection confirmation")
      setConnectionName("My research vault")
      setRootPath("")
      await refresh()
      setStatus(`${created.display_name} connected. Choose Browse to inspect files; nothing was imported automatically.`)
    } catch (cause) {
      setError(safeDatasourceError("connect", cause))
      setStatus("")
    } finally {
      setSaving(false)
    }
  }

  async function browse(connection: DatasourceConnection) {
    setBrowsingId(connection.id)
    setError("")
    setStatus(`Loading up to 200 items from ${connection.display_name}…`)
    try {
      const result = await galaxyBrainAPI.getDatasourceItems(connection.id, 200)
      if (!result) throw new Error("missing item list")
      setItemsByConnection((current) => ({ ...current, [connection.id]: result.items }))
      setStatus(result.truncated
        ? `Showing the first ${result.count} items from ${connection.display_name}; more items are available.`
        : `${result.count} item${result.count === 1 ? "" : "s"} available from ${connection.display_name}.`)
    } catch (cause) {
      setError(safeDatasourceError("browse", cause))
      setStatus("")
    } finally {
      setBrowsingId(null)
    }
  }

  async function sync(connection: DatasourceConnection) {
    setSyncingId(connection.id)
    setError("")
    setStatus(`Scanning ${connection.display_name} after your explicit request…`)
    try {
      const result = await galaxyBrainAPI.syncDatasourceConnection(connection.id)
      if (!result) throw new Error("missing sync confirmation")
      setConnections((current) => current.map((value) => value.id === connection.id ? result.connection : value))
      setStatus(`${result.message} This scan did not import, change, or delete source files.`)
    } catch (cause) {
      setError(safeDatasourceError("sync", cause))
      setStatus("")
    } finally {
      setSyncingId(null)
    }
  }

  async function persistDraft(draft: ImportDraft) {
    if (!ingestionScopePrefix) {
      setImportPhase("idle")
      setError("Wait for the authorized Atlas workspace before importing this datasource file.")
      setStatus("")
      return
    }
    if (!datasourceFileIngestionRegistered()) {
      setImportPhase("idle")
      setError("The registered datasource file ingestion plan is unavailable.")
      setStatus("")
      return
    }
    let transformClient
    try {
      transformClient = createDocumentTransformClient({ storage: window.localStorage })
    } catch {
      setImportPhase("idle")
      setError("Document analysis retry storage is unavailable. No durable document was created.")
      setStatus("")
      return
    }
    setImportPhase("importing")
    setError("")
    setStatus(`Running the registered datasource ingestion plan for ${draft.item.title}: preserve exact bytes first, then analyze…`)
    let confirmedDraft = draft
    try {
      const result = await executeIngestionPlan(DATASOURCE_FILE_INGESTION_PLAN_ID, {
        file: draft.file,
        metadata: {
          title: datasourceImportTitle(draft.item),
          filename: draft.file.name,
          sourceKind: "datasource",
          sourceUri: datasourceSourceUri(draft.connection, draft.item),
          arxivId: null,
        },
        scopePrefix: ingestionScopePrefix,
      }, {
        importDocument: async (file, metadata, signal) => {
          const confirmation = await galaxyBrainAPI.importDocument(file, metadata, signal)
          confirmedDraft = { ...draft, confirmation }
          setImportDraft(confirmedDraft)
          setImportPhase("transforming")
          setStatus("The exact datasource file is durable. Running bounded document analysis before placement…")
          return confirmation
        },
        transformDocument: (revisionId, options) => transformClient.transform(revisionId, options),
      })
      const ingestionNotice = datasourceIngestionOutcomeMessage(result)
      confirmedDraft = { ...confirmedDraft, ingestionNotice }
      setImportDraft(confirmedDraft)
      setImportPhase("placing")
      setStatus(`${ingestionNotice} Placing its pinned revision on this Atlas…`)
      if (!onDurableImport(result.confirmation, draft.target, ingestionNotice, result)) {
        setImportPhase("idle")
        setStatus("")
      }
    } catch (cause) {
      setImportPhase("idle")
      setError(confirmedDraft.confirmation
        ? "The exact source is durable, but the ingestion-plan outcome is unconfirmed. Retry placement without importing again."
        : cause instanceof IngestionPlanContractError
          ? "The registered datasource ingestion plan failed validation. No durable document was created."
        : safeDatasourceError("import", cause))
      setStatus("")
      setImportDraft(confirmedDraft)
    }
  }

  async function importItem(connection: DatasourceConnection, item: DatasourceItem) {
    if (!ingestionTarget) {
      setImportPhase("idle")
      setError("Wait for the authorized Atlas canvas before importing this datasource file.")
      setStatus("")
      return
    }
    const unavailable = datasourceDurableImportUnavailableReason(item, connection)
    if (unavailable) {
      setError(unavailable)
      setStatus("")
      return
    }
    setImportPhase("reading")
    setError("")
    setStatus(`Reading the exact authorized bytes of ${item.title}…`)
    try {
      const exact = await galaxyBrainAPI.getDatasourceItemContent(connection.id, item.id)
      const file = new File([exact.bytes], datasourceImportFilename(item), { type: exact.mediaType })
      const draft = {
        connection,
        item,
        file,
        confirmation: null,
        target: ingestionTarget,
        ingestionNotice: "The exact datasource file is durable.",
      }
      setImportDraft(draft)
      await persistDraft(draft)
    } catch (cause) {
      setImportPhase("idle")
      setImportDraft(null)
      setError(safeDatasourceError("read", cause))
      setStatus("")
    }
  }

  function retryImport() {
    if (!importDraft || busy) return
    if (importDraft.confirmation) {
      setImportPhase("placing")
      setError("")
      setStatus("Retrying the same pinned document placement…")
      if (!onDurableImport(
        importDraft.confirmation,
        importDraft.target,
        importDraft.ingestionNotice,
        null,
      )) {
        setImportPhase("idle")
        setStatus("")
      }
      return
    }
    void persistDraft(importDraft)
  }

  function abandonImport() {
    setImportDraft(null)
    setImportPhase("idle")
    setError("")
    setStatus("")
    setAbandonOpen(false)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return
        if (!nextOpen && importDraft) {
          setAbandonOpen(true)
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-h-[min(92vh,900px)] max-w-[min(96vw,860px)] overflow-y-auto"
        closeDisabled={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="research-display text-2xl outline-none">
            Research datasources
          </DialogTitle>
          <DialogDescription>
            Configure a server-owned connector, explicitly scan or browse it, then preserve selected exact files as durable Galaxy documents.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4 rounded-xl border border-[#93a48e]/45 bg-[#fbfaf2] p-4" onSubmit={createConnection}>
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-[#355346]" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-[#18372b]">Connect an approved source</h3>
              <p id="datasource-root-help" className="mt-1 text-xs leading-5 text-[#61766b]">
                The path is resolved on the Galaxy server and must remain inside a root pre-approved for this tenant. Atlas never chooses an arbitrary client path.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <label className="text-sm font-semibold" htmlFor="atlas-datasource-plugin">Connector type</label>
              <select
                ref={pluginRef}
                id="atlas-datasource-plugin"
                className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={selectedPluginId}
                disabled={busy || plugins.length === 0}
                onChange={(event) => setSelectedPluginId(event.target.value)}
              >
                {plugins.length === 0 ? <option value="">No plugins available</option> : null}
                {plugins.map((plugin) => <option key={plugin.id} value={plugin.id}>{plugin.display_name}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-semibold" htmlFor="atlas-datasource-name">Connection name</label>
              <Input
                ref={nameRef}
                id="atlas-datasource-name"
                value={connectionName}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setConnectionName(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="atlas-datasource-root">Approved server folder path</label>
            <Input
              id="atlas-datasource-root"
              value={rootPath}
              maxLength={2_048}
              disabled={busy}
              aria-describedby="datasource-root-help"
              placeholder="D:\\research\\papers"
              onChange={(event) => setRootPath(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" type="submit" disabled={busy || !selectedPluginId}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Database className="h-4 w-4" aria-hidden="true" />}
              Connect datasource
            </Button>
            <Button ref={refreshRef} className="min-h-11" type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh connections
            </Button>
          </div>
        </form>

        <section aria-labelledby="atlas-datasource-connections" className="grid gap-3">
          <div>
            <h3 id="atlas-datasource-connections" className="research-smallcaps text-sm text-[#52665b]">Connected datasources</h3>
            <p className="mt-1 text-xs text-[#61766b]">Sync is a manual, non-destructive scan. Browse and Import are separate explicit actions.</p>
          </div>
          {connections.length === 0 && !loading ? (
            <p className="rounded-xl border border-dashed border-[#93a48e]/55 p-5 text-sm text-[#61766b]">No datasource connections yet.</p>
          ) : (
            <ul className="grid gap-3">
              {connections.map((connection) => {
                const items = itemsByConnection[connection.id]
                return (
                  <li key={connection.id} className="rounded-xl border border-[#93a48e]/45 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-semibold text-[#18372b]">{connection.display_name}</p>
                        <p className="break-all text-xs text-[#61766b]">{connection.plugin_display_name || connection.plugin_id}{connection.root_path ? ` · ${connection.root_path}` : ""}</p>
                        <p className="mt-1 text-xs text-[#61766b]">
                          {connection.status} · {connection.last_synced_at ? `last scan ${new Date(connection.last_synced_at).toLocaleString()}` : "never scanned"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button className="min-h-11" type="button" size="sm" variant="outline" disabled={busy} onClick={() => void browse(connection)}>
                          {browsingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                          Browse
                        </Button>
                        <Button className="min-h-11" type="button" size="sm" variant="outline" disabled={busy} onClick={() => void sync(connection)}>
                          {syncingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                          Scan now
                        </Button>
                      </div>
                    </div>
                    {items ? (
                      <ul className="mt-4 grid max-h-72 gap-2 overflow-y-auto border-t border-[#d8c8a6]/55 pt-3" aria-label={`Files in ${connection.display_name}`}>
                        {items.length === 0 ? <li className="text-sm text-[#61766b]">No files found.</li> : items.map((item) => {
                          const unavailable = datasourceDurableImportUnavailableReason(item, connection)
                          return (
                            <li key={item.id} className="flex flex-col gap-3 rounded-lg bg-[#fbfaf2] p-3 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <p className="flex items-center gap-2 font-medium text-[#294438]"><FileText className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="break-words">{item.title}</span></p>
                                <p className="mt-1 break-all text-xs text-[#61766b]">{item.path || item.id}{item.size ? ` · ${item.size.toLocaleString()} bytes` : ""}</p>
                                {unavailable ? <p id={`datasource-import-help-${connection.id}-${encodeURIComponent(item.id)}`} className="mt-1 text-xs text-[#8a5a2c]">{unavailable}</p> : null}
                              </div>
                              <Button
                                className="min-h-11 shrink-0"
                                type="button"
                                size="sm"
                                disabled={busy || Boolean(unavailable)}
                                aria-describedby={unavailable ? `datasource-import-help-${connection.id}-${encodeURIComponent(item.id)}` : undefined}
                                onClick={() => void importItem(connection, item)}
                              >
                                Import and place
                              </Button>
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
        <p role="status" aria-live="polite" aria-atomic="true" className={status ? "text-sm text-[#486054]" : "sr-only"}>
          {status || "Datasource manager ready."}
        </p>
        <DialogFooter>
          {importDraft && importPhase === "idle" ? (
            <Button className="min-h-11" type="button" onClick={retryImport}>
              {importDraft.confirmation ? "Retry placement" : "Retry same import"}
            </Button>
          ) : null}
          <Button className="min-h-11" type="button" variant="outline" disabled={busy} onClick={() => importDraft ? setAbandonOpen(true) : onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this safe import retry?</AlertDialogTitle>
            <AlertDialogDescription>
              The exact file may already be durable. Continuing the retry reuses the same content-derived identity; abandoning keeps any confirmed document but stops placement recovery here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue retry</AlertDialogCancel>
            <AlertDialogAction onClick={abandonImport}>Abandon retry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

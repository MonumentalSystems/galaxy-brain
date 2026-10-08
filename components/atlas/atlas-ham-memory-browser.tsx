"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { HamMemoryWorkspace, type HamMemoryDraft } from "@/components/ham-memory-workspace"
import { HAMSearchModal } from "@/components/ham-search-modal"
import { buildHamMemorySupersedeChanges } from "@/lib/ham-memory-contract.js"
import {
  getHamMemory,
  linkHamMemories,
  supersedeHamMemory,
  unlinkHamMemories,
  type HamMemoryEdge,
  type HamMemoryMutationResult,
  type HamMemoryRelation,
  type HamMemoryView,
} from "@/lib/ham-memory-client"
import type { HamSearchResult } from "@/lib/ham-search-client"

export type AtlasHamMemoryBrowserProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: HTMLElement | null
  onMutationCommitted?: (result: HamMemoryMutationResult) => void
}

function safeMutationError(cause: unknown) {
  if (cause instanceof Error && cause.message === "Memory changed since it was read.") {
    return "This HAM memory changed. Reload it before creating a replacement."
  }
  return "HAM did not confirm the change. Reload the memory before deciding whether to try again."
}

export function AtlasHamMemoryBrowser({
  open,
  onOpenChange,
  returnFocus,
  onMutationCommitted,
}: AtlasHamMemoryBrowserProps) {
  const [memoryView, setMemoryView] = useState<HamMemoryView | null>(null)
  const [selectionBusyId, setSelectionBusyId] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState("")
  const [workspaceError, setWorkspaceError] = useState("")
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [refreshPendingId, setRefreshPendingId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [handoffFocus, setHandoffFocus] = useState(false)
  const generationRef = useRef(0)
  const selectionBusyRef = useRef(false)
  const workspaceBusyRef = useRef(false)

  const changeOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      generationRef.current += 1
      setMemoryView(null)
      setSelectionBusyId(null)
      setSelectionError("")
      setWorkspaceError("")
      setWorkspaceBusy(false)
      setRefreshPendingId(null)
      setAnnouncement("")
      setHandoffFocus(false)
      selectionBusyRef.current = false
      workspaceBusyRef.current = false
    }
    onOpenChange(nextOpen)
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return
    setSelectionError("")
    setWorkspaceError("")
  }, [open])

  const openMemory = useCallback((result: HamSearchResult) => {
    if (selectionBusyRef.current) return
    selectionBusyRef.current = true
    const generation = ++generationRef.current
    setSelectionBusyId(result.id)
    setSelectionError("")
    setHandoffFocus(false)
    void getHamMemory(result.id)
      .then((view) => {
        if (generation !== generationRef.current) return
        setHandoffFocus(true)
        setMemoryView(view)
        setRefreshPendingId(null)
        setAnnouncement(`Opened canonical HAM memory ${view.memory.id}, version ${view.memory.version}.`)
      })
      .catch(() => {
        if (generation !== generationRef.current) return
        setSelectionError("That HAM memory could not be opened. Refine the search or try again.")
      })
      .finally(() => {
        if (generation === generationRef.current) {
          selectionBusyRef.current = false
          setSelectionBusyId(null)
        }
      })
  }, [])

  const runViewOperation = useCallback(async (
    operation: () => Promise<HamMemoryView>,
    successMessage: (view: HamMemoryView) => string,
  ) => {
    if (workspaceBusyRef.current) return
    workspaceBusyRef.current = true
    const generation = ++generationRef.current
    setWorkspaceBusy(true)
    setWorkspaceError("")
    setAnnouncement("")
    try {
      const nextView = await operation()
      if (generation !== generationRef.current) return
      setMemoryView(nextView)
      setRefreshPendingId(null)
      setAnnouncement(successMessage(nextView))
    } catch (cause) {
      if (generation !== generationRef.current) return
      setWorkspaceError(safeMutationError(cause))
    } finally {
      if (generation === generationRef.current) {
        workspaceBusyRef.current = false
        setWorkspaceBusy(false)
      }
    }
  }, [])

  const runMutation = useCallback(async (
    operation: () => Promise<HamMemoryMutationResult>,
    successMessage: (view: HamMemoryView) => string,
    committedMessage: string,
  ) => {
    if (workspaceBusyRef.current) return
    workspaceBusyRef.current = true
    const generation = ++generationRef.current
    setWorkspaceBusy(true)
    setWorkspaceError("")
    setAnnouncement("")
    try {
      const result = await operation()
      if (generation !== generationRef.current) return
      if (result.status === "committed") {
        setMemoryView(result.view)
        setRefreshPendingId(null)
        setAnnouncement(successMessage(result.view))
      } else {
        setRefreshPendingId(result.memoryId)
        setAnnouncement(`${committedMessage} The view did not refresh; reload it before making another change.`)
      }
      onMutationCommitted?.(result)
    } catch (cause) {
      if (generation !== generationRef.current) return
      setWorkspaceError(safeMutationError(cause))
    } finally {
      if (generation === generationRef.current) {
        workspaceBusyRef.current = false
        setWorkspaceBusy(false)
      }
    }
  }, [onMutationCommitted])

  const reload = useCallback(() => {
    if (!memoryView) return
    void runViewOperation(
      () => getHamMemory(refreshPendingId ?? memoryView.memory.id),
      (view) => `Reloaded HAM memory ${view.memory.id}, version ${view.memory.version}.`,
    )
  }, [memoryView, refreshPendingId, runViewOperation])

  const supersede = useCallback((draft: HamMemoryDraft) => {
    if (!memoryView) return
    let changes
    try {
      changes = buildHamMemorySupersedeChanges(memoryView.memory, draft)
    } catch {
      setWorkspaceError("The replacement memory is invalid. Review its content and organization.")
      return
    }
    void runMutation(
      () => supersedeHamMemory(memoryView.memory.id, {
        expectedVersion: memoryView.memory.version,
        idempotencyKey: `atlas-ham-supersede:${crypto.randomUUID()}`,
        ...changes,
      }),
      (view) => `Created immutable replacement HAM memory ${view.memory.id}, version ${view.memory.version}.`,
      "The immutable replacement was committed in HAM.",
    )
  }, [memoryView, runMutation])

  const addEdge = useCallback((input: { relation: HamMemoryRelation; targetMemoryId: string }) => {
    if (!memoryView) return
    void runMutation(
      () => linkHamMemories(memoryView.memory.id, input),
      () => `Added the ${input.relation} relation to HAM memory ${input.targetMemoryId}.`,
      `The ${input.relation} relation was committed in HAM.`,
    )
  }, [memoryView, runMutation])

  const removeEdge = useCallback((edge: HamMemoryEdge) => {
    if (!memoryView || edge.kind !== "typed") return
    void runMutation(
      () => unlinkHamMemories(memoryView.memory.id, {
        linkId: edge.id,
        expectedVersion: edge.version,
        reason: "Removed from the canonical Galaxy HAM memory workspace.",
      }),
      () => `Removed the ${edge.relation} relation.`,
      `The ${edge.relation} relation removal was committed in HAM.`,
    )
  }, [memoryView, runMutation])

  const closeWorkspace = useCallback(() => changeOpen(false), [changeOpen])

  return (
    <>
      <HAMSearchModal
        open={open && memoryView === null}
        onOpenChange={changeOpen}
        onSelect={openMemory}
        returnFocus={returnFocus}
        selectionBusyId={selectionBusyId}
        selectionError={selectionError}
        handoffFocus={handoffFocus}
      />
      {open && memoryView ? (
        <HamMemoryWorkspace
          memory={memoryView.memory}
          edges={memoryView.edges}
          truncated={memoryView.truncated}
          busy={workspaceBusy}
          error={workspaceError}
          readOnlyReason={refreshPendingId
            ? "The last change was committed in HAM, but this view could not refresh. Reload the canonical memory before making another change; do not repeat the committed action."
            : undefined}
          onClose={closeWorkspace}
          onReload={reload}
          onSupersede={supersede}
          onAddEdge={addEdge}
          onRemoveEdge={removeEdge}
          onGalaxyLinkCreated={() => setAnnouncement("Created an authored Galaxy relation from this exact HAM memory.")}
          returnFocus={returnFocus}
        />
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {workspaceBusy ? "Updating canonical HAM memory…" : announcement}
      </p>
    </>
  )
}

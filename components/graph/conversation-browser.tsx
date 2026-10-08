"use client"

import { LoaderCircle, MapPinned, MessagesSquare, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { atlasReferenceHandoffHref } from "@/lib/atlas-reference-handoff.js"
import {
  acceptsConversationCollectionCompletion,
  appendConversationCollectionPage,
  CONVERSATION_COLLECTION_LIMIT,
  conversationCollectionPath,
  conversationGraphHref,
  readConversationCollectionResponse,
  startConversationCollection,
  type ConversationCollectionState,
} from "@/lib/conversation-collection-client.js"

type RequestFence = {
  generation: number
  tenantId: string
  workspaceId: string | null
  cursor: string | null
}

function safeMessage(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError" ? null : "Conversation maps are unavailable."
}

export function ConversationBrowser({
  tenantId,
  workspaceId = null,
  selectedConversationReference = null,
}: {
  tenantId: string
  workspaceId?: string | null
  selectedConversationReference?: string | null
}) {
  const [collection, setCollection] = useState<ConversationCollectionState | null>(null)
  const [firstLoading, setFirstLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [firstError, setFirstError] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [cursorExpired, setCursorExpired] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const generationRef = useRef(0)
  const fenceRef = useRef<RequestFence>({ generation: 0, tenantId, workspaceId, cursor: null })
  const collectionRef = useRef<ConversationCollectionState | null>(null)
  const moreControllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    moreControllerRef.current?.abort()
    setRefreshVersion((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const generation = generationRef.current + 1
    generationRef.current = generation
    const captured = { generation, tenantId, workspaceId, cursor: null }
    fenceRef.current = captured
    collectionRef.current = null
    setCollection(null)
    setFirstLoading(true)
    setMoreLoading(false)
    setFirstError(null)
    setMoreError(null)
    setCursorExpired(false)
    moreControllerRef.current?.abort()
    moreControllerRef.current = null

    fetch(conversationCollectionPath({ workspaceId, limit: CONVERSATION_COLLECTION_LIMIT }), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Conversation collection request failed")
        return readConversationCollectionResponse(response, {
          tenantId,
          workspaceId,
          limit: CONVERSATION_COLLECTION_LIMIT,
        })
      })
      .then((page) => {
        if (!acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) return
        const next = startConversationCollection(page)
        collectionRef.current = next
        setCollection(next)
      })
      .catch((error: unknown) => {
        if (!acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) return
        const message = safeMessage(error)
        if (message) setFirstError(message)
      })
      .finally(() => {
        if (acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) {
          setFirstLoading(false)
        }
      })

    return () => {
      controller.abort()
      moreControllerRef.current?.abort()
    }
  }, [refreshVersion, tenantId, workspaceId])

  const loadMore = useCallback(() => {
    const current = collectionRef.current
    const cursor = current?.continuation.cursor
    if (!current || !current.continuation.hasMore || !cursor || current.capped || moreControllerRef.current) return
    const controller = new AbortController()
    moreControllerRef.current = controller
    const captured = {
      generation: generationRef.current,
      tenantId,
      workspaceId,
      cursor,
    }
    fenceRef.current = captured
    setMoreLoading(true)
    setMoreError(null)
    setCursorExpired(false)

    fetch(conversationCollectionPath({ workspaceId, cursor, limit: CONVERSATION_COLLECTION_LIMIT }), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 422) {
          const error = new Error("Conversation collection cursor expired")
          Object.assign(error, { cursorExpired: true })
          throw error
        }
        if (!response.ok) throw new Error("Conversation collection request failed")
        return readConversationCollectionResponse(response, {
          tenantId,
          workspaceId,
          limit: CONVERSATION_COLLECTION_LIMIT,
        })
      })
      .then((page) => {
        if (!acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) return
        const active = collectionRef.current
        if (!active || active.continuation.cursor !== cursor) return
        const next = appendConversationCollectionPage(active, page)
        collectionRef.current = next
        setCollection(next)
      })
      .catch((error: unknown) => {
        if (!acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) return
        const message = safeMessage(error)
        if (!message) return
        if (error instanceof Error && Object.hasOwn(error, "cursorExpired")) {
          setCursorExpired(true)
          setMoreError("This conversation snapshot expired. Refresh from the first page to continue.")
        } else {
          setMoreError(message)
        }
      })
      .finally(() => {
        if (acceptsConversationCollectionCompletion(captured, fenceRef.current, controller.signal)) {
          setMoreLoading(false)
          moreControllerRef.current = null
        }
      })
  }, [tenantId, workspaceId])

  const conversations = collection?.conversations ?? []
  return (
    <section
      aria-labelledby="conversation-browser-title"
      className="graph-surface rounded-2xl border p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="graph-surface__muted mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
            <MessagesSquare aria-hidden="true" className="size-4" /> Conversation maps
          </p>
          <h2 id="conversation-browser-title" className="font-serif text-xl font-semibold">
            Browse durable conversation trees
          </h2>
          <p className="graph-surface__muted mt-1 max-w-2xl text-sm">
            Open an exact saved snapshot in the graph. Full turns load only after selection.
          </p>
        </div>
      </header>

      <div aria-live="polite" className="sr-only">
        {firstLoading ? "Loading conversation maps." : moreLoading ? "Loading more conversation maps." : ""}
      </div>

      {firstLoading ? (
        <p className="graph-surface__muted mt-4 flex min-h-11 items-center gap-2 text-sm" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          Loading conversation maps…
        </p>
      ) : firstError ? (
        <div className="graph-surface__danger mt-4 rounded-xl border p-3" role="alert">
          <p className="text-sm">{firstError}</p>
          <Button className="mt-3 min-h-11" onClick={refresh} size="sm" variant="outline">
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : conversations.length === 0 ? (
        <p className="graph-surface__muted mt-4 rounded-xl border border-dashed border-[hsl(var(--field-muted-strong))] px-4 py-6 text-sm">
          No conversation maps are available in this scope.
        </p>
      ) : (
        <>
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {conversations.map((conversation) => {
              const selected = selectedConversationReference === conversation.ref
              return (
                <li key={conversation.ref}>
                  <article className="graph-surface__panel h-full rounded-xl border p-3">
                    <h3 className="font-serif text-base font-semibold">
                      <Link
                        aria-current={selected ? "page" : undefined}
                        className="graph-surface__focus -m-1 inline-flex min-h-11 items-center rounded-md p-1 text-[hsl(var(--field-ink))] underline-offset-4 hover:underline focus-visible:outline-none"
                        href={conversationGraphHref(conversation.ref)}
                      >
                        {conversation.title}
                      </Link>
                    </h3>
                    <p className="graph-surface__muted mt-1 line-clamp-3 text-sm">{conversation.goalSummary}</p>
                    <dl className="graph-surface__muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <div><dt className="sr-only">Turns</dt><dd>{conversation.turnCount} turns</dd></div>
                      <div><dt className="sr-only">Artifacts</dt><dd>{conversation.artifactCount} artifacts</dd></div>
                      <div><dt className="sr-only">Workspace</dt><dd>{conversation.workspaceId}</dd></div>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button asChild className="min-h-11 w-full sm:w-auto" size="sm" variant="outline">
                        <Link
                          aria-label={`Place on Atlas: ${conversation.title}`}
                          href={atlasReferenceHandoffHref(conversation.ref)}
                        >
                          <MapPinned aria-hidden="true" /> Place on Atlas
                        </Link>
                      </Button>
                    </div>
                  </article>
                </li>
              )
            })}
          </ol>

          {moreError ? (
            <div className="graph-surface__danger mt-4 rounded-xl border p-3" role="alert">
              <p className="text-sm">{moreError}</p>
              <Button className="mt-3 min-h-11" onClick={cursorExpired ? refresh : loadMore} size="sm" variant="outline">
                <RefreshCw aria-hidden="true" /> {cursorExpired ? "Refresh from first page" : "Retry loading more"}
              </Button>
            </div>
          ) : null}

          {collection?.capped ? (
            <p className="graph-surface__muted mt-4 text-sm" role="status">
              Showing the first {conversations.length} conversation maps from this fixed snapshot.
            </p>
          ) : null}

          {collection && (collection.pageCount > 1 || collection.continuation.hasMore) && !moreError ? (
            <Button
              aria-disabled={moreLoading || collection.capped || !collection.continuation.hasMore}
              className="mt-4 min-h-11"
              onClick={() => {
                if (!moreLoading && !collection.capped && collection.continuation.hasMore) loadMore()
              }}
              size="sm"
              variant="outline"
            >
              {moreLoading ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
              {moreLoading
                ? "Loading…"
                : collection.capped
                  ? "Conversation map limit reached"
                  : collection.continuation.hasMore ? "Load more" : "All conversation maps loaded"}
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}

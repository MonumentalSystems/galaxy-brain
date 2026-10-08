"use client"

import { useEffect, useState } from "react"

import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import type {
  CanvasConversationShareBundle,
  CanvasShareBundle,
  LegacyShareSnapshot,
  ObjectShareBundle,
  ShareBundle,
} from "@/lib/types/sharing"

type ShareView =
  | { kind: "bundle"; value: ShareBundle }
  | { kind: "legacy"; value: LegacyShareSnapshot }

function ObjectBundle({ bundle }: { bundle: ObjectShareBundle }) {
  const { payload } = bundle
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-neutral-500">
        <span>Galaxy Brain Share</span><span>•</span><span>Object only</span><span>•</span><span>{payload.kind}</span>
      </div>
      <h1 className="mt-4 text-3xl font-semibold text-neutral-950 md:text-4xl">{payload.title}</h1>
      {payload.tags && payload.tags.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {payload.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {payload.content !== undefined ? (
        <article className="mt-8 whitespace-pre-wrap rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-sm leading-7 text-neutral-700">
          {payload.content}
        </article>
      ) : payload.source ? (
        <pre className="mt-8 overflow-x-auto rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-xs leading-6 text-neutral-700">
          {JSON.stringify(payload.source, null, 2)}
        </pre>
      ) : null}
      <dl className="mt-8 grid gap-3 rounded-2xl border border-neutral-200 bg-white p-5 text-xs text-neutral-600">
        <div><dt className="font-semibold text-neutral-900">Pinned reference</dt><dd className="mt-1 break-all font-mono">{payload.ref}</dd></div>
        <div><dt className="font-semibold text-neutral-900">Object revision</dt><dd className="mt-1 break-all font-mono">{payload.revision}</dd></div>
      </dl>
    </>
  )
}

function CanvasConversationBundle({ bundle }: { bundle: CanvasConversationShareBundle }) {
  const { canvas, conversation } = bundle.payload
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-[#4b6155]">
        <span>Galaxy Brain Share</span><span>•</span><span>Atlas + redacted transcript</span><span>•</span><span>Immutable</span>
      </div>
      <h1 className="research-display mt-4 text-3xl font-semibold text-[#18372b] md:text-4xl">{canvas.title}</h1>
      <div className="mt-5 grid gap-3 rounded-2xl border border-[#c9c3aa] bg-[#f9f6e8] p-5 text-sm text-[#425a4d] sm:grid-cols-2">
        <div><strong className="text-[#18372b]">Selected scope</strong><p className="mt-1">Canvas revision {canvas.version} and conversation revision {conversation.version}.</p></div>
        <div><strong className="text-[#18372b]">Access</strong><p className="mt-1">Signed-in members of the owning Galaxy tenant.</p></div>
        <div className="sm:col-span-2"><strong className="text-[#18372b]">Not live</strong><p className="mt-1">Future turns, future canvas changes, artifacts, runs, logs, presence, and edit rights are not included.</p></div>
      </div>
      <section className="mt-8" aria-labelledby="shared-canvas-heading">
        <h2 id="shared-canvas-heading" className="research-display text-2xl font-semibold text-[#18372b]">Atlas snapshot</h2>
        <p className="mt-2 text-sm text-[#4b6155]">{canvas.snapshot.items.length} items, {canvas.snapshot.edges.length} edges, and {canvas.snapshot.frames?.length ?? 0} frames.</p>
        {canvas.snapshot.frames?.length ? (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Presentation frames">
            {canvas.snapshot.frames.map((frame) => (
              <li key={frame.id} className="rounded-2xl border border-[#c9c3aa] bg-[#f9f6e8] p-4 text-xs">
                <p className="font-semibold text-[#18372b]">{frame.title}</p>
                <p className="mt-2 text-[#425a4d]">Tone {frame.tone}</p>
                <p className="mt-1 font-mono text-[#425a4d]">x {frame.x} · y {frame.y} · {frame.width} × {frame.height}</p>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {canvas.snapshot.items.map((item) => (
            <article key={item.id} className="rounded-2xl border border-[#c9c3aa] bg-[#f9f6e8] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#4b6155]">{item.nodeType}</p>
              <p className="mt-2 break-all font-mono text-xs text-[#425a4d]">{item.subjectRef}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="mt-10" aria-labelledby="shared-conversation-heading">
        <h2 id="shared-conversation-heading" className="research-display text-2xl font-semibold text-[#18372b]">{conversation.title}</h2>
        <p className="mt-2 text-sm text-[#4b6155]">{conversation.goal}</p>
        <ol className="mt-5 grid gap-4">
          {conversation.turns.map((turn) => (
            <li key={turn.turnId} className="rounded-2xl border border-[#c9c3aa] bg-white/80 p-5">
              <div className="flex flex-wrap justify-between gap-2 text-xs uppercase tracking-wide text-[#4b6155]">
                <span>{turn.role}</span><span>Turn {turn.ordinal}</span>
              </div>
              {turn.publication.status === "published" ? (
                <MarkdownRenderer content={turn.publication.content} images="omit" className="research-markdown mt-4" />
              ) : (
                <p className="mt-4 rounded-xl border border-[#c9c3aa] bg-[#f9f6e8] px-3 py-2 text-sm text-[#4b6155]">
                  {turn.role === "system" ? "System instruction" : "Tool output"} omitted from this redacted share.
                </p>
              )}
            </li>
          ))}
        </ol>
        {conversation.edges.length > 0 ? (
          <details className="mt-5 rounded-2xl border border-[#c9c3aa] bg-[#f9f6e8] p-4">
            <summary className="cursor-pointer font-semibold text-[#18372b]">Conversation lineage ({conversation.edges.length})</summary>
            <ul className="mt-3 grid gap-2 text-xs text-[#425a4d]">
              {conversation.edges.map((edge) => <li key={edge.edgeId} className="break-all font-mono">{edge.fromTurnId} —{edge.kind}→ {edge.toTurnId}</li>)}
            </ul>
          </details>
        ) : null}
      </section>
      <dl className="mt-8 grid gap-3 rounded-2xl border border-[#c9c3aa] bg-white/80 p-5 text-xs text-[#425a4d]">
        <div><dt className="font-semibold text-[#18372b]">Canvas content hash</dt><dd className="mt-1 break-all font-mono">{canvas.contentHash}</dd></div>
        <div><dt className="font-semibold text-[#18372b]">Conversation reference</dt><dd className="mt-1 break-all font-mono">{conversation.ref}</dd></div>
      </dl>
    </>
  )
}

function CanvasBundle({ bundle }: { bundle: CanvasShareBundle }) {
  const { payload } = bundle
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-neutral-500">
        <span>Galaxy Brain Share</span><span>•</span><span>Canvas only</span><span>•</span><span>Version {payload.version}</span>
      </div>
      <h1 className="mt-4 text-3xl font-semibold text-neutral-950 md:text-4xl">{payload.title}</h1>
      <p className="mt-3 text-sm text-neutral-600">
        Immutable layout with {payload.snapshot.items.length} items, {payload.snapshot.edges.length} edges, and {payload.snapshot.frames?.length ?? 0} frames.
      </p>
      {payload.snapshot.frames?.length ? (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Presentation frames">
          {payload.snapshot.frames.map((frame) => (
            <li key={frame.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-xs">
              <p className="font-semibold text-neutral-900">{frame.title}</p>
              <p className="mt-2 text-neutral-600">Tone {frame.tone}</p>
              <p className="mt-1 font-mono text-neutral-600">x {frame.x} · y {frame.y} · {frame.width} × {frame.height}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {payload.snapshot.items.map((item) => (
          <article key={item.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{item.nodeType}</p>
            <p className="mt-2 break-all text-xs font-mono text-neutral-700">{item.subjectRef}</p>
            <p className="mt-3 text-xs text-neutral-500">x {item.x} · y {item.y} · {item.width} × {item.height}</p>
          </article>
        ))}
      </div>
      <dl className="mt-8 grid gap-3 rounded-2xl border border-neutral-200 bg-white p-5 text-xs text-neutral-600">
        <div><dt className="font-semibold text-neutral-900">Canvas ID</dt><dd className="mt-1 break-all font-mono">{payload.canvasId}</dd></div>
        <div><dt className="font-semibold text-neutral-900">Canvas content hash</dt><dd className="mt-1 break-all font-mono">{payload.contentHash}</dd></div>
      </dl>
    </>
  )
}

function LegacySnapshot({ snapshot }: { snapshot: LegacyShareSnapshot }) {
  const payload = snapshot.snapshot_json || {}
  const title = typeof payload.title === "string" ? payload.title : `Shared ${snapshot.target_type}`
  const content = typeof payload.content === "string" ? payload.content : ""
  const tags = Array.isArray(payload.tags) ? payload.tags : []

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-neutral-500">
        <span>Galaxy Brain Share</span><span>•</span><span>Legacy snapshot</span><span>•</span><span>{snapshot.target_type}</span>
      </div>
      <h1 className="mt-4 text-3xl font-semibold text-neutral-950 md:text-4xl">{title}</h1>
      {tags.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={String(tag)} className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
              {String(tag)}
            </span>
          ))}
        </div>
      ) : null}
      {content ? (
        <article className="mt-8 whitespace-pre-wrap rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-sm leading-7 text-neutral-700">
          {content}
        </article>
      ) : (
        <pre className="mt-8 overflow-x-auto rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-xs leading-6 text-neutral-700">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
      <p className="mt-8 break-all border-t border-neutral-200 pt-5 text-xs text-neutral-500">
        Snapshot {snapshot.id} · created {new Date(snapshot.created_at).toLocaleString()}
      </p>
    </>
  )
}

export default function ShareBundlePage({
  params,
}: {
  params: Promise<{ snapshotId: string }>
}) {
  const [bundleId, setBundleId] = useState("")
  const [share, setShare] = useState<ShareView | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    params.then(({ snapshotId }) => {
      if (!cancelled) setBundleId(snapshotId)
    })
    return () => { cancelled = true }
  }, [params])

  useEffect(() => {
    if (!bundleId) return
    let cancelled = false
    setLoading(true)
    galaxyBrainAPI.getShareBundle(bundleId)
      .then(async (bundle) => {
        if (bundle) return { kind: "bundle", value: bundle } as const
        const snapshot = await galaxyBrainAPI.getLegacyShareSnapshot(bundleId)
        return snapshot ? { kind: "legacy", value: snapshot } as const : null
      })
      .then((result) => { if (!cancelled) setShare(result) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bundleId])

  if (loading) {
    return <main className="min-h-screen bg-neutral-50 p-8 text-neutral-950"><div className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 shadow-sm"><p className="text-sm uppercase tracking-[0.2em] text-neutral-500">Galaxy Brain Share</p><h1 className="mt-3 text-3xl font-semibold">Loading shared bundle…</h1></div></main>
  }

  if (!share) {
    return <main className="min-h-screen bg-neutral-50 p-8 text-neutral-950"><div className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 shadow-sm"><p className="text-sm uppercase tracking-[0.2em] text-neutral-500">Authenticated share</p><h1 className="mt-3 text-3xl font-semibold">Bundle unavailable</h1><p className="mt-3 text-neutral-600">Sign in to the owning tenant, or ask its creator for a valid bundle.</p></div></main>
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#eef6ff,_#f8fafc_50%,_#ffffff)] p-6 text-neutral-950 md:p-10">
      <div className="mx-auto max-w-4xl rounded-3xl border border-neutral-200 bg-white/90 p-8 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur md:p-10">
        {share.kind === "legacy" ? <LegacySnapshot snapshot={share.value} /> : (
          <>
            {share.value.schemaId === "gb.share-bundle.v1"
              ? share.value.mode === "object-only"
                ? <ObjectBundle bundle={share.value} />
                : <CanvasBundle bundle={share.value} />
              : <CanvasConversationBundle bundle={share.value} />}
            <p className="mt-8 break-all border-t border-neutral-200 pt-5 text-xs text-neutral-500">
              Bundle {share.value.contentHash} · created {new Date(share.value.createdAt).toLocaleString()}
            </p>
          </>
        )}
      </div>
    </main>
  )
}

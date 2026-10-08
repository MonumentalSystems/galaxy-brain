"use client"

import { useEffect, useId, useRef, useState } from "react"

import {
  isAllowedSvgElement,
  rewriteSvgReferences,
  sanitizeSvgAttribute,
  screenSvgSource,
  SVG_TEXT_ELEMENTS,
} from "@/lib/surface-svg-policy"

const SVG_NS = "http://www.w3.org/2000/svg"
/** A diagram, not a document: enough for anything an agent draws by hand. */
const MAX_ELEMENTS = 4000

/*
  The source is never handed to the DOM as markup. It is parsed into a
  detached XML document — which has no browsing context, so nothing in it runs
  or loads — and a fresh drawing is built from it one node at a time, with the
  policy deciding every element and attribute. Text arrives as text nodes and
  attributes through setAttribute, so there is no string the browser ever
  re-parses as SVG or HTML.
*/
function rebuild(source: Element, prefix: string, budget: { remaining: number }): SVGElement | null {
  const name = source.localName
  if (source.namespaceURI !== SVG_NS || !isAllowedSvgElement(name)) return null
  if (--budget.remaining < 0) return null

  const element = document.createElementNS(SVG_NS, name)
  for (const attribute of Array.from(source.attributes)) {
    const kept = sanitizeSvgAttribute(name, attribute.name, attribute.value)
    if (kept === null) continue
    const value = rewriteSvgReferences(prefix, attribute.name, kept)
    // `xlink:href` is the legacy spelling; plain `href` is what browsers read.
    element.setAttribute(attribute.name === "xlink:href" ? "href" : attribute.name, value)
  }

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const rebuilt = rebuild(child as Element, prefix, budget)
      if (rebuilt) element.appendChild(rebuilt)
    } else if (
      (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE)
      && SVG_TEXT_ELEMENTS.has(name)
    ) {
      element.appendChild(document.createTextNode(child.textContent ?? ""))
    }
    // Comments and processing instructions are not part of the drawing.
  }
  return element
}

function drawingFrom(source: string, prefix: string): SVGElement | string {
  const rejected = screenSvgSource(source)
  if (rejected) return rejected

  const parsed = new DOMParser().parseFromString(source, "image/svg+xml")
  if (parsed.getElementsByTagName("parsererror").length > 0) return "SVG could not be read"
  const root = parsed.documentElement
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS) return "Source is not an SVG document"

  const drawing = rebuild(root, prefix, { remaining: MAX_ELEMENTS })
  if (!drawing) return "SVG could not be drawn safely"

  // Without a viewBox a fixed width and height cannot scale down to fit.
  const width = Number.parseFloat(drawing.getAttribute("width") ?? "")
  const height = Number.parseFloat(drawing.getAttribute("height") ?? "")
  if (!drawing.hasAttribute("viewBox") && width > 0 && height > 0) {
    drawing.setAttribute("viewBox", `0 0 ${width} ${height}`)
  }
  drawing.removeAttribute("width")
  drawing.removeAttribute("height")
  return drawing
}

/*
  Generous sizes its preview container, and the contract accepts that. Here it
  caps the width; height is accepted but not applied, because the drawing's own
  aspect ratio decides it and a fixed height on a responsive SVG would crop it.
  Re-checked rather than trusted: this boundary exists for rows that bypassed
  the API's validation.
*/
function maximumWidth(width: unknown): string | undefined {
  if (typeof width === "number" && width > 0 && width <= 4096) return `${width}px`
  if (typeof width === "string" && /^[0-9]+(\.[0-9]+)?(px|%|em|rem)?$/.test(width) && width.length <= 16) {
    return /[a-z%]$/.test(width) ? width : `${width}px`
  }
  return undefined
}

export function SurfaceSvg({ svg, title, width }: { svg: string; title?: string; width?: unknown }) {
  const container = useRef<HTMLDivElement>(null)
  const prefix = `svg${useId().replace(/[^A-Za-z0-9_-]/g, "")}`
  const [problem, setProblem] = useState("")

  useEffect(() => {
    const host = container.current
    if (!host) return
    const drawing = drawingFrom(svg, prefix)
    if (typeof drawing === "string") {
      host.replaceChildren()
      setProblem(drawing)
      return
    }
    setProblem("")
    host.replaceChildren(drawing)
    return () => host.replaceChildren()
  }, [prefix, svg])

  return (
    <figure className="space-y-2" data-slot="surface-svg" style={{ maxWidth: maximumWidth(width) }}>
      <div
        ref={container}
        role="img"
        aria-label={title || "Diagram"}
        className="overflow-hidden rounded-xl border border-cosmic-200/70 bg-white/75 p-3 dark:border-white/10 dark:bg-cosmic-950/55 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
      />
      {problem ? (
        <p role="alert" className="text-sm text-destructive">This diagram was not shown: {problem}.</p>
      ) : null}
      {title ? <figcaption className="text-sm text-cosmic-600 dark:text-cosmic-300">{title}</figcaption> : null}
    </figure>
  )
}

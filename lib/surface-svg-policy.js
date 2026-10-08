/**
 * What a promoted surface may draw with SVG.
 *
 * Surfaces are untrusted content, and SVG is a document format rather than a
 * picture: it can carry scripts, event handlers, embedded HTML and fetches to
 * arbitrary URLs. The renderer therefore never injects SVG markup. It parses
 * the source and rebuilds a new drawing from scratch, asking this module about
 * every element and attribute; anything not named here is dropped.
 *
 * These are pure functions so each decision can be tested without a DOM.
 */

/** Elements a static diagram is made of. Nothing that loads, embeds or runs. */
export const SVG_ALLOWED_ELEMENTS = Object.freeze(new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan",
  "marker", "clipPath", "linearGradient", "radialGradient", "stop", "pattern",
]))

/** Elements whose text content is part of the drawing. */
export const SVG_TEXT_ELEMENTS = Object.freeze(new Set(["text", "tspan", "title", "desc"]))

/**
 * Geometry, paint and typography. No `on*` handler, no `style` (handled
 * separately), no `href` (handled separately), nothing that names a resource.
 *
 * No `class` either: it would let a diagram borrow the page's own stylesheet,
 * and a root `<svg class="fixed inset-0 z-50">` would lay itself over the app.
 */
const PLAIN_ATTRIBUTES = new Set([
  "id", "viewBox", "preserveAspectRatio", "transform",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "width", "height", "d", "points", "pathLength",
  "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "fill", "fill-opacity", "fill-rule", "clip-rule",
  "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit",
  "opacity", "color", "visibility", "display",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift",
  "letter-spacing", "word-spacing", "text-decoration", "writing-mode",
  "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "spreadMethod",
  "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "clipPathUnits", "patternUnits", "patternContentUnits", "patternTransform",
  "marker-start", "marker-mid", "marker-end", "clip-path",
  "vector-effect", "shape-rendering", "text-rendering",
])

/** Presentation properties a `style` attribute may set. */
const STYLE_PROPERTIES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-miterlimit", "opacity", "color", "visibility", "display",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "text-anchor", "dominant-baseline", "letter-spacing", "word-spacing",
  "text-decoration", "stop-color", "stop-opacity",
  "marker-start", "marker-mid", "marker-end", "clip-path",
])

const MAX_ID_LENGTH = 128
const LOCAL_URL = /^url\(\s*(['"]?)#([A-Za-z_][\w.:-]*)\1\s*\)$/
/** Anything that could leave the document or reach script. */
const DANGEROUS_VALUE = /javascript:|vbscript:|data:|expression\(|@import|behaviou?r:|-moz-binding/i
/**
 * Every `(` must follow one of these names. Colour, maths and transform
 * functions only: an unknown function could be a resource (`src()`,
 * `image-set()`) or one the browser learns later. `url` is allowed here and
 * then held to a whole-value local reference.
 */
const ALLOWED_FUNCTIONS = new Set([
  "", "url",
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
  "calc", "min", "max", "clamp",
  "matrix", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
  "rotate", "skewx", "skewy",
])
const FUNCTION_NAME = /([^\s(),:;'"]*)\(/g

export function isAllowedSvgElement(name) {
  return SVG_ALLOWED_ELEMENTS.has(name)
}

/**
 * A paint or reference value is only allowed to point inside this drawing.
 * Returns the referenced id for `url(#id)`, or null when it has no reference.
 * Throws nothing: an external or malformed reference makes the value unsafe.
 */
function localReferenceIn(value) {
  const match = LOCAL_URL.exec(value.trim())
  return match ? match[2] : null
}

function isSafeValue(value) {
  if (typeof value !== "string" || value.length > 4096) return false
  // CSS escapes and comments let a value spell one thing and mean another:
  // `u\72l(https://…)` is `url(https://…)` to the browser. No geometry, paint
  // or font value needs either, so refuse them rather than decode them.
  if (value.includes("\\") || value.includes("/*")) return false
  if (DANGEROUS_VALUE.test(value.replace(/\s+/g, ""))) return false
  for (const [, name] of value.matchAll(FUNCTION_NAME)) {
    if (!ALLOWED_FUNCTIONS.has(name.toLowerCase())) return false
  }
  // A url() is only acceptable as a whole-value reference to a local id.
  return !/url\s*\(/i.test(value) || localReferenceIn(value) !== null
}

/**
 * Decide one attribute. Returns the value to keep, or null to drop it.
 *
 * `href` is the dangerous one in SVG: on `<use>` it can pull in an external
 * document, on anything else it is a link. Only a fragment pointing inside
 * this drawing survives, and only on `<use>`.
 */
export function sanitizeSvgAttribute(element, name, value) {
  if (typeof name !== "string" || typeof value !== "string") return null
  const lower = name.toLowerCase()
  if (lower.startsWith("on")) return null

  if (lower === "href" || lower === "xlink:href") {
    if (element !== "use") return null
    return /^#[A-Za-z_][\w.:-]*$/.test(value.trim()) ? value.trim() : null
  }
  if (lower === "style") return sanitizeSvgStyle(value)
  if (!PLAIN_ATTRIBUTES.has(name)) return null
  if (name === "id" && (value.length > MAX_ID_LENGTH || !/^[A-Za-z_][\w.:-]*$/.test(value))) return null
  return isSafeValue(value) ? value : null
}

/**
 * Keep only allowlisted presentation properties from a `style` attribute, each
 * value held to the same rules as the equivalent attribute. Returns null when
 * nothing survives.
 */
export function sanitizeSvgStyle(style) {
  if (typeof style !== "string" || style.length > 4096) return null
  const kept = []
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (!STYLE_PROPERTIES.has(property) || !value) continue
    if (value.includes("{") || value.includes("}") || value.includes("<")) continue
    if (!isSafeValue(value)) continue
    kept.push(`${property}: ${value}`)
  }
  return kept.length > 0 ? kept.join("; ") : null
}

/**
 * Ids are global to the page, so two diagrams that both define `#arrow` would
 * steal each other's markers. Every id is given a per-instance prefix, and
 * every local reference is rewritten to match.
 */
export function prefixSvgId(prefix, id) {
  return `${prefix}-${id}`
}

export function rewriteSvgReferences(prefix, name, value) {
  const lower = name.toLowerCase()
  if (lower === "id") return prefixSvgId(prefix, value)
  if (lower === "href" || lower === "xlink:href") {
    return value.startsWith("#") ? `#${prefixSvgId(prefix, value.slice(1))}` : value
  }
  return value.replace(
    /url\(\s*(['"]?)#([A-Za-z_][\w.:-]*)\1\s*\)/g,
    (_match, _quote, id) => `url(#${prefixSvgId(prefix, id)})`,
  )
}

/**
 * Cheap screening before parsing: the source must be one SVG document, and
 * must not declare a DOCTYPE or entities (entity expansion is how a few
 * hundred bytes become gigabytes inside a parser).
 */
export function screenSvgSource(source) {
  if (typeof source !== "string") return "SVG source is missing"
  // The contract bounds code points, as Python's len() counts them.
  if (source.length === 0 || codePointLength(source) > MAX_SVG_SOURCE_LENGTH) {
    return "SVG source is empty or too large"
  }
  if (/<!\s*(doctype|entity)/i.test(source)) return "SVG declarations are not allowed"
  if (!SVG_DOCUMENT_START.test(source)) return "Source is not an SVG document"
  return null
}

const MAX_SVG_SOURCE_LENGTH = 20_000

/**
 * The contract's own pattern (gb.surface.v1 SVGPreview.svg), so the renderer
 * and the server agree on what an SVG document is. A comment body cannot
 * contain `-->`, which keeps matching linear: the earlier `<!--[\s\S]*?-->`
 * let each comment swallow the next, and doubled its work per comment.
 */
const SVG_DOCUMENT_START = /^\s*(<\?xml[^>]*\?>\s*)?(<!--(?:[^-]|-(?!->))*-->\s*)*<[sS][vV][gG][\s>/]/

function codePointLength(value) {
  if (value.length <= MAX_SVG_SOURCE_LENGTH) return value.length
  let count = 0
  for (const _codePoint of value) count += 1
  return count
}

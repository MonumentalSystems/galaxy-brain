import assert from "node:assert/strict"
import test from "node:test"

import {
  isAllowedSvgElement,
  rewriteSvgReferences,
  sanitizeSvgAttribute,
  sanitizeSvgStyle,
  screenSvgSource,
} from "../lib/surface-svg-policy.js"

test("only inert drawing elements are allowed", () => {
  for (const name of ["svg", "g", "path", "circle", "text", "tspan", "marker", "linearGradient", "use"]) {
    assert.equal(isAllowedSvgElement(name), true, name)
  }
  for (const name of ["script", "foreignObject", "iframe", "image", "a", "animate", "set", "style", "feImage", "SCRIPT"]) {
    assert.equal(isAllowedSvgElement(name), false, name)
  }
})

test("event handlers never survive, whatever their case", () => {
  for (const name of ["onclick", "onload", "onLoad", "ONMOUSEOVER", "onbegin"]) {
    assert.equal(sanitizeSvgAttribute("rect", name, "alert(1)"), null, name)
  }
})

test("href survives only as a local fragment on <use>", () => {
  assert.equal(sanitizeSvgAttribute("use", "href", "#arrow"), "#arrow")
  assert.equal(sanitizeSvgAttribute("use", "xlink:href", " #arrow "), "#arrow")
  assert.equal(sanitizeSvgAttribute("use", "href", "https://evil.example/x.svg#a"), null)
  assert.equal(sanitizeSvgAttribute("use", "href", "javascript:alert(1)"), null)
  assert.equal(sanitizeSvgAttribute("use", "href", "data:image/svg+xml,<svg/>"), null)
  assert.equal(sanitizeSvgAttribute("rect", "href", "#arrow"), null)
  assert.equal(sanitizeSvgAttribute("text", "xlink:href", "#x"), null)
})

test("paint may reference only ids inside the drawing", () => {
  assert.equal(sanitizeSvgAttribute("rect", "fill", "url(#grad)"), "url(#grad)")
  assert.equal(sanitizeSvgAttribute("rect", "fill", "url('#grad')"), "url('#grad')")
  assert.equal(sanitizeSvgAttribute("path", "marker-end", "url(#arrow)"), "url(#arrow)")
  assert.equal(sanitizeSvgAttribute("rect", "fill", "url(https://tracker.example/p.svg#g)"), null)
  assert.equal(sanitizeSvgAttribute("rect", "fill", "url(data:image/png;base64,AAAA)"), null)
  assert.equal(sanitizeSvgAttribute("rect", "fill", "red url(#a)"), null)
  assert.equal(sanitizeSvgAttribute("rect", "fill", "#3b82f6"), "#3b82f6")
  assert.equal(sanitizeSvgAttribute("rect", "fill", "rgb(59, 130, 246)"), "rgb(59, 130, 246)")
})

test("escaped and spaced script schemes are still caught", () => {
  for (const value of ["javascript:alert(1)", "java\\script:alert(1)", "JaVaScRiPt:x", "java script:x", "\\6a avascript:x"]) {
    assert.equal(sanitizeSvgAttribute("rect", "fill", value), null, value)
  }
})

test("escaped or disguised external references are refused, not decoded", () => {
  // Each of these is url(https://…) or another fetch to the browser.
  const disguised = [
    String.raw`u\72l(https://example.com/paint.svg#g)`,
    String.raw`\75rl(https://example.com/paint.svg#g)`,
    String.raw`u\000072 l(https://example.com/paint.svg#g)`,
    String.raw`u\rl(https://example.com/paint.svg#g)`,
    String.raw`url(\68ttps://example.com/paint.svg#g)`,
    "u/**/rl(https://example.com/paint.svg#g)",
    "URL(https://example.com/paint.svg#g)",
    "url (https://example.com/paint.svg#g)",
    "src(https://example.com/paint.svg#g)",
    "image-set('https://example.com/p.png' 1x)",
    "-webkit-image-set(url(https://example.com/p.png) 1x)",
    "var(--page-token)",
  ]
  for (const value of disguised) {
    assert.equal(sanitizeSvgAttribute("rect", "fill", value), null, `attribute: ${value}`)
    assert.equal(sanitizeSvgStyle(`fill: ${value}`), null, `style: ${value}`)
    assert.equal(sanitizeSvgStyle(`stroke: blue; fill: ${value}`), "stroke: blue", `mixed style: ${value}`)
  }
})

test("ordinary colour, maths and transform functions still draw", () => {
  for (const [name, value] of [
    ["fill", "hsl(210 80% 50% / 0.5)"],
    ["stroke", "oklch(0.7 0.1 200)"],
    ["stroke-width", "calc(2px + 1px)"],
    ["transform", "translate(10, 20) rotate(45 5 5) scale(2) skewX(10)"],
    ["transform", "matrix(1 0 0 1 10 10)"],
    ["font-family", "'Helvetica Neue', Arial, sans-serif"],
  ]) {
    assert.equal(sanitizeSvgAttribute("rect", name, value), value, `${name}: ${value}`)
  }
})

test("unknown and resource-naming attributes are dropped", () => {
  for (const name of ["class", "src", "action", "formaction", "xmlns:ev", "requiredExtensions", "attributeName"]) {
    assert.equal(sanitizeSvgAttribute("rect", name, "x"), null, name)
  }
})

test("ids must be plain identifiers", () => {
  assert.equal(sanitizeSvgAttribute("marker", "id", "arrow-head_1"), "arrow-head_1")
  assert.equal(sanitizeSvgAttribute("marker", "id", "1bad"), null)
  assert.equal(sanitizeSvgAttribute("marker", "id", "a b"), null)
  assert.equal(sanitizeSvgAttribute("marker", "id", "x".repeat(200)), null)
})

test("style keeps allowlisted presentation and nothing else", () => {
  assert.equal(sanitizeSvgStyle("fill: red; stroke-width: 2"), "fill: red; stroke-width: 2")
  assert.equal(sanitizeSvgStyle("fill: red; position: fixed; top: 0"), "fill: red")
  assert.equal(sanitizeSvgStyle("background: url(https://tracker.example/p.png)"), null)
  assert.equal(sanitizeSvgStyle("fill: url(https://tracker.example/p.svg#g)"), null)
  assert.equal(sanitizeSvgStyle("fill: url(#grad)"), "fill: url(#grad)")
  assert.equal(sanitizeSvgStyle("fill: expression(alert(1))"), null)
  assert.equal(sanitizeSvgStyle("fill: red } body { display: none"), null)
  assert.equal(sanitizeSvgStyle("behavior: url(x.htc)"), null)
  assert.equal(sanitizeSvgStyle(""), null)
})

test("references are rewritten to the instance prefix", () => {
  assert.equal(rewriteSvgReferences("s1", "id", "arrow"), "s1-arrow")
  assert.equal(rewriteSvgReferences("s1", "href", "#arrow"), "#s1-arrow")
  assert.equal(rewriteSvgReferences("s1", "marker-end", "url(#arrow)"), "url(#s1-arrow)")
  assert.equal(rewriteSvgReferences("s1", "style", "fill: url('#g'); stroke: blue"), "fill: url(#s1-g); stroke: blue")
  assert.equal(rewriteSvgReferences("s1", "fill", "#ff0000"), "#ff0000")
})

test("source screening refuses declarations and non-SVG documents", () => {
  assert.equal(screenSvgSource('<svg viewBox="0 0 10 10"><circle r="4"/></svg>'), null)
  assert.equal(screenSvgSource('<?xml version="1.0"?>\n<svg></svg>'), null)
  assert.equal(screenSvgSource("<!-- diagram -->\n<svg></svg>"), null)
  assert.notEqual(screenSvgSource('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>'), null)
  assert.notEqual(screenSvgSource("<html><svg></svg></html>"), null)
  assert.notEqual(screenSvgSource("<svgx></svgx>"), null)
  assert.notEqual(screenSvgSource(""), null)
  assert.notEqual(screenSvgSource("x".repeat(20_001)), null)
  assert.notEqual(screenSvgSource(42), null)
  // XML reserves the lower-case declaration; the contract refuses <?XML too.
  assert.notEqual(screenSvgSource('<?XML version="1.0"?><svg></svg>'), null)
})

test("source screening counts code points, as the contract does", () => {
  const drawing = (body) => `<svg>${body}</svg>`
  // 19,989 emoji: 39,978 UTF-16 units, but within 20,000 code points.
  assert.equal(screenSvgSource(drawing("😀".repeat(19_989))), null)
  assert.notEqual(screenSvgSource(drawing("😀".repeat(19_990))), null)
})

test("source screening stays linear on stacked comments", () => {
  for (const source of [
    "<!---->".repeat(2_800) + "x",
    "<!--" + "-".repeat(19_000),
    "<!--<!--".repeat(2_400) + "x",
  ]) {
    const started = performance.now()
    assert.notEqual(screenSvgSource(source), null)
    assert.ok(performance.now() - started < 250, `${source.slice(0, 12)}… took too long`)
  }
  assert.equal(screenSvgSource("<!---->\n".repeat(2_000) + "<svg/>"), null)
})

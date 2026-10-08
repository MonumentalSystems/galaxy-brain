import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"

import {
  markdownForMathDisplay,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from "../lib/markdown-math.js"

function render(source) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    skipHtml: true,
    remarkPlugins: markdownRemarkPlugins,
    rehypePlugins: markdownRehypePlugins,
  }, markdownForMathDisplay(source)))
}

test("renders dollar and agent-style TeX math with accessible MathML", () => {
  const markup = render("Inline $E=mc^2$ and \\(x+y\\).\n\n\\[\n\\frac{a}{b}\n\\]")
  assert.match(markup, /class="katex"/)
  assert.match(markup, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/)
  assert.match(markup, /class="katex-display"/)
  assert.match(markup, /class="frac-line"/)
})

test("keeps code examples as code and does not execute raw HTML or TeX URLs", () => {
  const source = "`\\(x\\)`\n\n```tex\n\\[not math\\]\n```\n\n<script>alert(1)</script>\n\n$\\href{javascript:alert(1)}{bad}$"
  const converted = markdownForMathDisplay(source)
  assert.match(converted, /`\\\(x\\\)`/)
  assert.match(converted, /```tex\n\\\[not math\\\]\n```/)
  const markup = render(source)
  assert.doesNotMatch(markup, /<script|href="javascript:/i)
  assert.match(markup, /<code>\\\(x\\\)<\/code>/)
})

test("keeps unsupported paper-defined macros visibly raw", async () => {
  const markup = render("Instantons on $S^{4}$ and $\\cpbar$")
  const inlineMath = await readFile(new URL("../components/inline-math-text.tsx", import.meta.url), "utf8")

  assert.match(markup, /mathcolor="#cc0000"/)
  assert.match(markup, /\\cpbar/)
  assert.match(inlineMath, /throwOnError: true/)
})

test("all Markdown projections use the shared safe renderer without changing raw export", async () => {
  const [renderer, eln, surface, task, paper, layout, workspace, nodePreview] = await Promise.all([
    readFile(new URL("../components/markdown-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/workspace/research-markdown-document.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/surfaces/surface-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/tasks/task-detail-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/workspace/task-workspace-surface.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/node-preview.tsx", import.meta.url), "utf8"),
  ])
  assert.match(renderer, /skipHtml[\s\S]*remarkPlugins=\{markdownRemarkPlugins\}[\s\S]*rehypePlugins=\{markdownRehypePlugins\}/)
  assert.match(eln, /<MarkdownRenderer content=\{markdown\} images="omit"/)
  assert.match(surface, /<MarkdownRenderer content=\{content\} images="omit"/)
  assert.match(task, /<MarkdownRenderer content=\{shown\.goal\} images="omit"/)
  assert.match(paper, /<MarkdownRenderer content=\{annotation\.body\} images="omit"/)
  assert.match(layout, /katex\/dist\/katex\.min\.css/)
  assert.match(workspace, /<code>\{markdown\}<\/code>/)
  assert.match(nodePreview, /<MarkdownRenderer[\s\S]*content=\{node\.content\}/)
  assert.match(renderer, /images === "embedded"[\s\S]*isEmbeddedRasterImageSource/)
  assert.match(renderer, /defaultUrlTransform/)
})

"use client"

import { useCallback, useState } from "react"
import { Check, Clipboard } from "lucide-react"
import Prism from "prismjs"
import "prismjs/components/prism-typescript"
import "prismjs/components/prism-javascript"
import "prismjs/components/prism-jsx"
import "prismjs/components/prism-tsx"
import "prismjs/components/prism-css"
import "prismjs/components/prism-python"
import "prismjs/components/prism-json"
import "prismjs/components/prism-bash"
import "prismjs/components/prism-sql"
import "prismjs/components/prism-go"
import "prismjs/components/prism-rust"
import "prismjs/components/prism-yaml"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import { isEmbeddedRasterImageSource } from "@/lib/markdown-image-policy.js"
import { markdownForMathDisplay, markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-math"

export type MarkdownRendererProps = {
  content: string
  className?: string
  /** Restrict provenance-sensitive projections to converter-embedded raster bytes. */
  images?: "show" | "embedded" | "omit"
}

export function MarkdownRenderer({ content, className = "", images = "show" }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        skipHtml
        urlTransform={(url, key, node) => (
          images === "embedded"
          && key === "src"
          && node.tagName === "img"
          && isEmbeddedRasterImageSource(url)
            ? url
            : defaultUrlTransform(url)
        )}
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={{
          // Style overrides for rendered markdown elements
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-3 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold mt-5 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 my-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ className: codeClassName, children, ...props }) => {
            const isInline = !codeClassName
            if (isInline) {
              return (
                <code className="bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5 text-sm font-mono" {...props}>
                  {children}
                </code>
              )
            }
            // Fenced code block with syntax highlighting
            const lang = codeClassName?.replace("language-", "") || ""
            const codeStr = String(children).replace(/\n$/, "")
            let html: string
            try {
              html = Prism.languages[lang]
                ? Prism.highlight(codeStr, Prism.languages[lang], lang)
                : escapeHtml(codeStr)
            } catch {
              html = escapeHtml(codeStr)
            }
            return <HighlightedBlock html={html} raw={codeStr} lang={lang} />
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border border-gray-200 dark:border-gray-700 px-3 py-2 text-left text-sm font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm">
              {children}
            </td>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-blue-600 dark:text-blue-400 underline hover:no-underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          hr: () => (
            <hr className="my-4 border-gray-200 dark:border-gray-700" />
          ),
          img: ({ src, alt }) => images === "omit" || (
            images === "embedded" && !isEmbeddedRasterImageSource(src)
          )
            ? <span className="italic text-muted-foreground">[Image omitted: {alt || "untitled"}]</span>
            : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={alt || "Extracted document image"}
                loading="lazy"
                decoding="async"
                className="max-w-full h-auto rounded-md my-3"
              />
            ),
          input: ({ type, checked, ...props }) => {
            if (type === "checkbox") {
              return (
                <input type="checkbox" checked={checked} readOnly className="mr-2 rounded" {...props} />
              )
            }
            return <input type={type} {...props} />
          },
        }}
      >
        {markdownForMathDisplay(content)}
      </ReactMarkdown>
    </div>
  )
}

/** Syntax-highlighted code block with copy button and language badge */
function HighlightedBlock({ html, raw, lang }: { html: string; raw: string; lang: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [raw])

  return (
    <div className="relative group my-3 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-800">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-gray-200/60 dark:bg-gray-700/60 text-xs text-muted-foreground">
        <span className="font-mono">{lang || "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto m-0">
        <code
          className="text-sm font-mono leading-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  )
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

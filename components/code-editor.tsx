"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Check, Clipboard, Play, RotateCcw } from "lucide-react"
import Prism from "prismjs"
import "prismjs/components/prism-typescript"
import "prismjs/components/prism-javascript"
import "prismjs/components/prism-jsx"
import "prismjs/components/prism-tsx"
import "prismjs/components/prism-css"
import "prismjs/components/prism-python"
import "prismjs/components/prism-json"
import "prismjs/components/prism-bash"
import "prismjs/components/prism-markdown"
import "prismjs/components/prism-sql"
import "prismjs/components/prism-go"
import "prismjs/components/prism-rust"
import "prismjs/components/prism-yaml"
import "prismjs/components/prism-latex"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "python"
  | "css"
  | "json"
  | "bash"
  | "sql"
  | "go"
  | "rust"
  | "yaml"
  | "markdown"
  | "latex"
  | "plaintext"

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  python: "Python",
  css: "CSS",
  json: "JSON",
  bash: "Bash",
  sql: "SQL",
  go: "Go",
  rust: "Rust",
  yaml: "YAML",
  markdown: "Markdown",
  latex: "LaTeX",
  plaintext: "Plain Text",
}

/** Guess language from file extension */
export function guessLanguage(filename: string): SupportedLanguage {
  const ext = filename.split(".").pop()?.toLowerCase()
  const map: Record<string, SupportedLanguage> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    mts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    py: "python",
    css: "css",
    json: "json",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    go: "go",
    rs: "rust",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    mdx: "markdown",
    tex: "latex",
    latex: "latex",
  }
  return map[ext || ""] || "plaintext"
}

type CodeEditorProps = {
  value: string
  onChange: (value: string) => void
  language?: SupportedLanguage
  onLanguageChange?: (lang: SupportedLanguage) => void
  onRun?: (code: string) => void
  readOnly?: boolean
  className?: string
  showToolbar?: boolean
  languageLocked?: boolean
  textareaLabel?: string
}

export function CodeEditor({
  value,
  onChange,
  language = "typescript",
  onLanguageChange,
  onRun,
  readOnly = false,
  className = "",
  showToolbar = true,
  languageLocked = false,
  textareaLabel = "Source code",
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const keyboardHelpId = useId()
  const [copied, setCopied] = useState(false)
  const [tabMovesFocus, setTabMovesFocus] = useState(false)

  // Sync scroll between textarea and highlighted overlay
  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  // Highlight code
  const highlighted = (() => {
    if (language === "plaintext" || !Prism.languages[language]) {
      return escapeHtml(value || " ")
    }
    try {
      return Prism.highlight(value || " ", Prism.languages[language], language)
    } catch {
      return escapeHtml(value || " ")
    }
  })()

  const lineCount = (value || "").split("\n").length

  // Handle Tab key for indentation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key.toLowerCase() === "m") {
      e.preventDefault()
      setTabMovesFocus((current) => !current)
      return
    }
    if (e.key === "Tab") {
      if (e.shiftKey || tabMovesFocus) {
        setTabMovesFocus(false)
        return
      }
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd

      if (e.shiftKey) {
        // Outdent: remove leading 2 spaces from selected lines
        const before = value.substring(0, start)
        const selected = value.substring(start, end)
        const after = value.substring(end)
        const lineStart = before.lastIndexOf("\n") + 1
        const prefix = value.substring(lineStart, start)
        const fullSelected = prefix + selected
        const outdented = fullSelected.replace(/^  /gm, "")
        const diff = fullSelected.length - outdented.length
        const newValue = value.substring(0, lineStart) + outdented + after
        onChange(newValue)
        requestAnimationFrame(() => {
          ta.selectionStart = Math.max(lineStart, start - (prefix.startsWith("  ") ? 2 : 0))
          ta.selectionEnd = end - diff
        })
      } else {
        // Indent: insert 2 spaces
        const newValue = value.substring(0, start) + "  " + value.substring(end)
        onChange(newValue)
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2
        })
      }
    } else if (e.key === "Enter") {
      // Auto-indent: match the indentation of the current line
      const ta = e.currentTarget
      const start = ta.selectionStart
      const lineStart = value.lastIndexOf("\n", start - 1) + 1
      const line = value.substring(lineStart, start)
      const indent = line.match(/^(\s*)/)?.[1] || ""

      // Extra indent after { or :
      const lastChar = value.substring(start - 1, start)
      const extra = lastChar === "{" || lastChar === ":" ? "  " : ""

      e.preventDefault()
      const newValue = value.substring(0, start) + "\n" + indent + extra + value.substring(ta.selectionEnd)
      onChange(newValue)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1 + indent.length + extra.length
      })
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`flex flex-col border rounded-md overflow-hidden ${className}`}>
      {/* Toolbar */}
      {showToolbar && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b">
          {languageLocked ? (
            <span className="flex min-h-7 items-center rounded-md border px-3 text-xs" aria-label={`Language: ${LANGUAGE_LABELS[language]}`}>
              {LANGUAGE_LABELS[language]}
            </span>
          ) : (
            <Select disabled={readOnly} value={language} onValueChange={(v) => onLanguageChange?.(v as SupportedLanguage)}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LANGUAGE_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Copy source code" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Clipboard className="h-3.5 w-3.5" />}
            </Button>
            {onRun && (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => onRun(value)}>
                <Play className="h-3.5 w-3.5" />
                Run
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Editor body */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden bg-gray-50 dark:bg-gray-950">
        {/* Line numbers */}
        <div
          className="flex-shrink-0 select-none text-right pr-3 pl-3 pt-3 pb-3 text-xs font-mono leading-5 text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 overflow-hidden"
          aria-hidden
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1}>{i + 1}</div>
          ))}
        </div>

        {/* Code area */}
        <div className="relative flex-1 min-w-0 overflow-auto" onScroll={syncScroll}>
          {/* Syntax-highlighted layer */}
          <pre
            ref={highlightRef}
            className="absolute inset-0 p-3 text-sm font-mono leading-5 whitespace-pre overflow-hidden pointer-events-none m-0"
            aria-hidden
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />

          {/* Editable textarea (transparent text, visible caret) */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={readOnly ? undefined : handleKeyDown}
            readOnly={readOnly}
            aria-label={textareaLabel}
            aria-describedby={keyboardHelpId}
            spellCheck={false}
            className="relative w-full h-full p-3 text-sm font-mono leading-5 bg-transparent text-transparent caret-gray-800 dark:caret-gray-200 resize-none outline-none whitespace-pre overflow-auto min-h-[200px]"
            style={{ tabSize: 2 }}
          />
          <span id={keyboardHelpId} className="sr-only">
            Press Control plus M to toggle whether Tab indents or moves focus. Shift plus Tab always moves focus backward.
          </span>
        </div>
      </div>
    </div>
  )
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

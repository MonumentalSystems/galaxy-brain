"use client"

import { useCallback, useRef, useState } from "react"
import { GripVertical, Play, Plus, Trash2, Type, Code, ChevronDown, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CodeEditor, type SupportedLanguage } from "@/components/code-editor"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Textarea } from "@/components/ui/textarea"

export type CellType = "code" | "markdown"

export type NotebookCell = {
  id: string
  type: CellType
  content: string
  language: SupportedLanguage
  output: string | null
  collapsed: boolean
}

type NotebookViewProps = {
  cells: NotebookCell[]
  onChange: (cells: NotebookCell[]) => void
  className?: string
}

function createCell(type: CellType): NotebookCell {
  return {
    id: `cell-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    type,
    content: "",
    language: "javascript",
    output: null,
    collapsed: false,
  }
}

/** Parse a flat string into notebook cells (for loading from stored content) */
export function parseCells(content: string): NotebookCell[] {
  if (!content.trim()) {
    return [createCell("code")]
  }

  // Try JSON parse first (native format)
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
      return parsed
    }
  } catch {
    // Not JSON, treat as single code cell
  }

  return [{ ...createCell("code"), content }]
}

/** Serialize cells to a string for storage */
export function serializeCells(cells: NotebookCell[]): string {
  return JSON.stringify(cells)
}

export function NotebookView({ cells, onChange, className = "" }: NotebookViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [runningCellId, setRunningCellId] = useState<string | null>(null)

  const updateCell = useCallback(
    (id: string, updates: Partial<NotebookCell>) => {
      onChange(cells.map((c) => (c.id === id ? { ...c, ...updates } : c)))
    },
    [cells, onChange],
  )

  const addCell = useCallback(
    (afterId: string, type: CellType) => {
      const idx = cells.findIndex((c) => c.id === afterId)
      const newCells = [...cells]
      newCells.splice(idx + 1, 0, createCell(type))
      onChange(newCells)
    },
    [cells, onChange],
  )

  const deleteCell = useCallback(
    (id: string) => {
      if (cells.length <= 1) return // Keep at least one cell
      onChange(cells.filter((c) => c.id !== id))
    },
    [cells, onChange],
  )

  const moveCell = useCallback(
    (id: string, direction: -1 | 1) => {
      const idx = cells.findIndex((c) => c.id === id)
      const newIdx = idx + direction
      if (newIdx < 0 || newIdx >= cells.length) return
      const newCells = [...cells]
      ;[newCells[idx], newCells[newIdx]] = [newCells[newIdx], newCells[idx]]
      onChange(newCells)
    },
    [cells, onChange],
  )

  // Execute a code cell in a sandboxed iframe
  const runCell = useCallback(
    (cellId: string) => {
      const cell = cells.find((c) => c.id === cellId)
      if (!cell || cell.type !== "code") return

      setRunningCellId(cellId)
      updateCell(cellId, { output: "Running..." })

      const handler = (event: MessageEvent) => {
        if (event.data?.source !== "galaxy-notebook") return
        if (event.data.cellId !== cellId) return

        const { type, content } = event.data
        updateCell(cellId, {
          output: (prev: string | null) => {
            // This is a workaround — we accumulate output
            const existing = cells.find((c) => c.id === cellId)?.output
            if (existing === "Running..." || existing === null) return content
            return existing + "\n" + content
          },
        } as any)

        if (type === "result" || type === "error") {
          window.removeEventListener("message", handler)
          setRunningCellId(null)
        }
      }
      window.addEventListener("message", handler)

      // Gather all previous code cell outputs as context
      const previousCode = cells
        .slice(
          0,
          cells.findIndex((c) => c.id === cellId),
        )
        .filter((c) => c.type === "code" && c.content.trim())
        .map((c) => c.content)
        .join("\n")

      const fullCode = previousCode ? previousCode + "\n" + cell.content : cell.content
      const sandboxHtml = buildNotebookSandboxHtml(fullCode, cellId)

      if (iframeRef.current) {
        iframeRef.current.srcdoc = sandboxHtml
      }

      // Timeout
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler)
        updateCell(cellId, { output: "Error: Execution timed out after 10 seconds" })
        setRunningCellId(null)
        if (iframeRef.current) iframeRef.current.srcdoc = ""
      }, 10000)

      const cleanup = (event: MessageEvent) => {
        if (event.data?.source !== "galaxy-notebook" || event.data.cellId !== cellId) return
        if (event.data.type === "result" || event.data.type === "error") {
          clearTimeout(timeout)
          window.removeEventListener("message", cleanup)
        }
      }
      window.addEventListener("message", cleanup)
    },
    [cells, updateCell],
  )

  // Run all code cells in order
  const runAll = useCallback(() => {
    const codeCells = cells.filter((c) => c.type === "code" && c.content.trim())
    if (codeCells.length === 0) return
    // Run them sequentially by using the iframe approach
    // For simplicity, run them all at once with accumulated code
    codeCells.forEach((cell) => {
      updateCell(cell.id, { output: null })
    })
    // Run last cell which includes all previous code
    if (codeCells.length > 0) {
      runCell(codeCells[codeCells.length - 1].id)
    }
  }, [cells, runCell, updateCell])

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={runAll}>
            <Play className="h-3.5 w-3.5" />
            Run All
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              const last = cells[cells.length - 1]
              addCell(last.id, "code")
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Code
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              const last = cells[cells.length - 1]
              addCell(last.id, "markdown")
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Markdown
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">{cells.length} cell{cells.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Cells */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {cells.map((cell, idx) => (
          <div
            key={cell.id}
            className={`border rounded-md overflow-hidden ${
              runningCellId === cell.id ? "border-blue-400 dark:border-blue-600" : "border-gray-200 dark:border-gray-800"
            }`}
          >
            {/* Cell header */}
            <div className="flex items-center justify-between px-2 py-1 bg-gray-50 dark:bg-gray-900 border-b text-xs">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground font-mono w-8">
                  [{idx + 1}]
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => updateCell(cell.id, { collapsed: !cell.collapsed })}
                >
                  {cell.collapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </Button>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  cell.type === "code"
                    ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                    : "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                }`}>
                  {cell.type === "code" ? "Code" : "Markdown"}
                </span>
              </div>

              <div className="flex items-center gap-0.5">
                {cell.type === "code" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => runCell(cell.id)}
                    disabled={runningCellId !== null}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => updateCell(cell.id, { type: cell.type === "code" ? "markdown" : "code" })}
                >
                  {cell.type === "code" ? <Type className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => deleteCell(cell.id)}
                  disabled={cells.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Cell body */}
            {!cell.collapsed && (
              <>
                {cell.type === "code" ? (
                  <CodeEditor
                    value={cell.content}
                    onChange={(v) => updateCell(cell.id, { content: v })}
                    language={cell.language}
                    onLanguageChange={(l) => updateCell(cell.id, { language: l })}
                    showToolbar={false}
                    className="border-0 rounded-none"
                  />
                ) : (
                  <div className="p-3">
                    <Textarea
                      value={cell.content}
                      onChange={(e) => updateCell(cell.id, { content: e.target.value })}
                      placeholder="Write markdown here..."
                      className="min-h-[60px] border-none focus-visible:ring-0 p-0 resize-none"
                      rows={3}
                    />
                    {cell.content.trim() && (
                      <div className="mt-2 pt-2 border-t">
                        <MarkdownRenderer content={cell.content} />
                      </div>
                    )}
                  </div>
                )}

                {/* Output */}
                {cell.type === "code" && cell.output !== null && (
                  <div className="border-t bg-gray-950 px-3 py-2 font-mono text-sm">
                    <pre className={`whitespace-pre-wrap break-all ${
                      cell.output.startsWith("Error") ? "text-red-400" : "text-green-400"
                    }`}>
                      {cell.output}
                    </pre>
                  </div>
                )}
              </>
            )}

            {/* Add cell button between cells */}
            {idx < cells.length - 1 && (
              <div className="flex justify-center -mb-1.5 relative z-10">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 rounded-full bg-background border opacity-0 hover:opacity-100 transition-opacity"
                  onClick={() => addCell(cell.id, "code")}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Hidden sandboxed iframe */}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        className="hidden"
        title="Notebook Sandbox"
      />
    </div>
  )
}

function buildNotebookSandboxHtml(code: string, cellId: string): string {
  const escapedCode = code
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/<\/script>/gi, "<\\/script>")

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script>
const _post = (type, ...args) => {
  const content = args.map(a => {
    if (a === undefined) return 'undefined';
    if (a === null) return 'null';
    if (typeof a === 'object') {
      try { return JSON.stringify(a, null, 2); }
      catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  parent.postMessage({ source: 'galaxy-notebook', cellId: '${cellId}', type, content }, '*');
};

console.log = (...args) => _post('log', ...args);
console.error = (...args) => _post('error', ...args);
console.warn = (...args) => _post('warn', ...args);
console.info = (...args) => _post('info', ...args);

try {
  const __result = (function() {
    "use strict";
    ${escapedCode}
  })();
  if (__result !== undefined) {
    _post('result', __result);
  } else {
    _post('result', '(no return value)');
  }
} catch (err) {
  _post('error', err.name + ': ' + err.message);
}
</script>
</body>
</html>`
}

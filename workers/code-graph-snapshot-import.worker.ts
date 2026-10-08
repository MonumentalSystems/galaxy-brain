/// <reference lib="webworker" />

import { parseCodeGraphSnapshotBytes } from "@/lib/code-graph-snapshot-import.js"

type SnapshotRequest = Readonly<{ requestId: number; bytes: ArrayBuffer }>

self.addEventListener("message", async (event: MessageEvent<SnapshotRequest>) => {
  const requestId = event.data?.requestId
  if (!Number.isSafeInteger(requestId) || !(event.data?.bytes instanceof ArrayBuffer)) return
  try {
    const review = await parseCodeGraphSnapshotBytes(event.data.bytes)
    self.postMessage({ requestId, ok: true, review })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "invalid"
    const messages: Record<string, string> = {
      "duplicate-key": "The snapshot contains a duplicate JSON field.",
      encoding: "The snapshot must be valid UTF-8 JSON.",
      json: "The snapshot is not valid JSON.",
      schema: "The JSON does not match the supported Codebase Memory snapshot schema.",
      size: "The snapshot is outside the supported file-size bound.",
      structure: "The snapshot exceeds a safe JSON structure bound.",
    }
    self.postMessage({ requestId, ok: false, code, error: messages[code] || "The snapshot could not be reviewed safely." })
  }
})

export {}

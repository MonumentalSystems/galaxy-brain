import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  inferPdfImportTitle,
  titleFromFirstPageText,
  usablePdfTitle,
} from "../lib/pdf-import-title.js"

test("embedded PDF titles reject download identifiers and normalize authoring prefixes", () => {
  assert.equal(usablePdfTitle("Microsoft Word - Vortex Transport in Layered Media", "2404.06147.pdf"), "Vortex Transport in Layered Media")
  assert.equal(usablePdfTitle("2404.06147", "2404.06147.pdf"), null)
  assert.equal(usablePdfTitle("9f86d081884c7d659a2feaa0c55ad015", "download.pdf"), null)
  assert.equal(usablePdfTitle("download", "download.pdf"), null)
})

test("first-page layout joins adjacent large title lines and ignores the arXiv banner", () => {
  const items = [
    { str: "arXiv:2404.06147v2", transform: [9, 0, 0, 9, 40, 760] },
    { str: "Harmonic Memory for", transform: [22, 0, 0, 22, 80, 690] },
    { str: "Scientific Discovery", transform: [22, 0, 0, 22, 80, 650] },
    { str: "Ada Researcher", transform: [12, 0, 0, 12, 80, 610] },
    { str: "Abstract", transform: [14, 0, 0, 14, 80, 500] },
  ]
  assert.equal(
    titleFromFirstPageText(items, 792, "2404.06147.pdf"),
    "Harmonic Memory for Scientific Discovery",
  )
})

test("PDF inference prefers embedded metadata and destroys the parsed document", async () => {
  let destroyed = false
  const document = {
    getMetadata: async () => ({ info: { Title: "Geometric Resonance in Coupled Fields" } }),
    getPage: async () => { throw new Error("metadata should win") },
    destroy: async () => { destroyed = true },
  }
  const file = {
    name: "2f4c81a06d9f4f8f.pdf",
    size: 4,
    arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  }
  const result = await inferPdfImportTitle(file, {
    pdfjsLoader: async () => ({ getDocument: () => ({ promise: Promise.resolve(document) }) }),
  })
  assert.deepEqual(result, { title: "Geometric Resonance in Coupled Fields", source: "metadata" })
  assert.equal(destroyed, true)
})

test("PDF inference falls back to first-page layout when metadata is absent", async () => {
  const document = {
    getMetadata: async () => ({ info: {} }),
    getPage: async () => ({
      getTextContent: async () => ({ items: [
        { str: "A Reliable Automatic Title", transform: [20, 0, 0, 20, 60, 700] },
      ] }),
      getViewport: () => ({ height: 792 }),
    }),
    destroy: async () => {},
  }
  const file = {
    name: "random-download.pdf",
    size: 4,
    arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  }
  const result = await inferPdfImportTitle(file, {
    pdfjsLoader: async () => ({ getDocument: () => ({ promise: Promise.resolve(document) }) }),
  })
  assert.deepEqual(result, { title: "A Reliable Automatic Title", source: "first-page" })
})

test("PDF inference rejects oversized files before loading PDF.js or reading bytes", async () => {
  let loaded = false
  let read = false
  const result = await inferPdfImportTitle({
    name: "oversized.pdf",
    size: 100_000_001,
    arrayBuffer: async () => {
      read = true
      return new ArrayBuffer(0)
    },
  }, {
    pdfjsLoader: async () => {
      loaded = true
      throw new Error("PDF.js must not load")
    },
  })
  assert.equal(result, null)
  assert.equal(loaded, false)
  assert.equal(read, false)
})

test("document import waits for automatic PDF title detection without requiring manual lookup", async () => {
  const dialog = await readFile(
    new URL("../components/atlas/document-import-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(dialog, /inferPdfImportTitle\(plan\.file\)/u)
  assert.ok(
    dialog.indexOf("planAtlasFileImport(nextFile)") < dialog.indexOf("inferPdfImportTitle(plan.file)"),
    "the file must pass the import bounds before PDF.js reads it",
  )
  assert.match(dialog, /titleDetection === "detecting" \? "Detecting title…"/u)
  assert.match(dialog, /Title detected automatically from the PDF/u)
  assert.doesNotMatch(dialog, /replace random download IDs/u)
})

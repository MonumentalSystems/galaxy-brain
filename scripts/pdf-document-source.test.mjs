import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { pdfDocumentSource } from "../lib/pdf-document-source.js"

// A complete one-page PDF exercises PDF.js parsing, rather than a mocked loader.
function samplePdf() {
  const stream = "BT /F1 12 Tf 20 50 Td (Paper regression fixture) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function assertReadable(source) {
  const loadingTask = getDocument({ ...source, useSystemFonts: true })
  try {
    const doc = await loadingTask.promise
    assert.equal(doc.numPages, 1)
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    assert.equal(content.items.map((item) => item.str).join(" "), "Paper regression fixture")
  } finally {
    await loadingTask.destroy()
  }
}

test("PDF URL sources fetch the selected revision instead of parsing the URL as bytes", async () => {
  const requests = []
  const pdf = samplePdf()
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length })
    res.end(pdf)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const path = "/api/eln/papers/paper-1/download?revision_id=revision-2"
    await assertReadable(pdfDocumentSource(`http://127.0.0.1:${server.address().port}${path}`))
    assert.deepEqual(requests, [path])
    assert.deepEqual(pdfDocumentSource(path), { url: path })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("existing ArrayBuffer and base64 PDF sources still load", async () => {
  const pdf = samplePdf()
  await assertReadable(pdfDocumentSource(Uint8Array.from(pdf).buffer))
  await assertReadable(pdfDocumentSource(`data:application/pdf;base64,${pdf.toString("base64")}`))
})

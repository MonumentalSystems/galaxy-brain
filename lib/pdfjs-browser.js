const PDFJS_VERSION = "5.6.205"
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build`

let pdfjsPromise = null

/**
 * Load pdf.js without passing it through the Next.js bundler. The CDN version
 * must stay aligned with the worker URL or pdf.js rejects the worker handshake.
 */
export async function loadPdfJs() {
  if (pdfjsPromise) return pdfjsPromise
  pdfjsPromise = (async () => {
    const library = await import(/* webpackIgnore: true */ `${PDFJS_CDN}/pdf.min.mjs`)
    library.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`
    return library
  })()
  return pdfjsPromise
}

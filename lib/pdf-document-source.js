/** @param {string | ArrayBuffer} data */
export function pdfDocumentSource(data) {
  if (data instanceof ArrayBuffer) return { data: new Uint8Array(data) }
  if (data.startsWith("data:")) {
    const binary = atob(data.split(",")[1])
    return { data: Uint8Array.from(binary, (character) => character.charCodeAt(0)) }
  }
  return { url: data }
}

export type PdfImportTitle = {
  title: string
  source: "metadata" | "first-page"
}

export function usablePdfTitle(value: unknown, filename?: string): string | null
export function titleFromFirstPageText(items: unknown[], pageHeight: number, filename?: string): string | null
export function inferPdfImportTitle(
  file: File,
  options?: { pdfjsLoader?: () => Promise<any> },
): Promise<PdfImportTitle | null>

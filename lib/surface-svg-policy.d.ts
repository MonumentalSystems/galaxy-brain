export const SVG_ALLOWED_ELEMENTS: ReadonlySet<string>
export const SVG_TEXT_ELEMENTS: ReadonlySet<string>
export function isAllowedSvgElement(name: string): boolean
export function sanitizeSvgAttribute(element: string, name: string, value: string): string | null
export function sanitizeSvgStyle(style: string): string | null
export function prefixSvgId(prefix: string, id: string): string
export function rewriteSvgReferences(prefix: string, name: string, value: string): string
export function screenSvgSource(source: unknown): string | null

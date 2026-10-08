import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs((2 * l) - 1)) * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const offset = l - (chroma / 2)
  let rgb
  if (hue < 60) rgb = [chroma, x, 0]
  else if (hue < 120) rgb = [x, chroma, 0]
  else if (hue < 180) rgb = [0, chroma, x]
  else if (hue < 240) rgb = [0, x, chroma]
  else if (hue < 300) rgb = [x, 0, chroma]
  else rgb = [chroma, 0, x]
  return rgb.map((channel) => channel + offset)
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right))
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right))
  return (lighter + 0.05) / (darker + 0.05)
}

test("authenticated research routes share one accessible lens rail without a wrapper shell", async () => {
  const shell = await read("components/auth-shell.tsx")
  const graph = await read("app/graph/page.tsx")
  const fieldRoute = await read("app/field/page.tsx")
  const graphClient = await read("app/graph/graph-client.tsx")
  const nav = await read("components/workspace/galaxy-lens-nav.tsx")
  const styles = await read("app/globals.css")

  assert.match(shell, /<GalaxyLensNav \/>/)
  assert.doesNotMatch(graph, /GalaxyLensNav/)
  assert.doesNotMatch(shell, /data-slot="galaxy-field-shell"/)
  assert.doesNotMatch(styles, /\.app-shell/)
  assert.match(styles, /body \{[\s\S]*background-attachment: fixed/)
  assert.match(nav, /aria-label="Galaxy lenses"/)
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/)
  assert.match(nav, /overflow-x-auto/)
  assert.match(nav, /min-h-11 min-w-11/)
  assert.match(nav, /href: "\/surfaces", matchPath: "\/surfaces", label: "Surfaces"/)
  assert.match(nav, /href: "\/library", matchPath: "\/library", label: "Library"/)
  assert.doesNotMatch(nav, /href: "\/surfaces", matchPath: "\/surfaces", label: "Views"/)
  assert.match(nav, /title=\{`\$\{label\} lens`\}/)
  // The rail moves between surfaces and links to the canonical Atlas plainly.
  for (const href of ["/workspace", "/field", "/graph", "/library", "/papers", "/tasks", "/eln", "/surfaces"]) {
    assert.ok(nav.includes(`href: "${href}"`), `missing lens href ${href}`)
  }
  assert.match(fieldRoute, /await requireUser\(\)/)
  assert.match(fieldRoute, /<AuthShell user=\{user\} ownsAccountMenu>/)
  assert.match(fieldRoute, /<TopRail lead=\{<TopRailTitle>Field<\/TopRailTitle>\}/)
  assert.match(fieldRoute, /<GraphClient key=\{user\.tenantId\} tenantId=\{user\.tenantId\} presentation="field"/)
  assert.match(graphClient, /presentation === "graph" && shouldUseCorpusWindow/)
  assert.match(graphClient, /projectUnifiedGraphToSemanticField\(loaded\.projection/)
  assert.match(graphClient, /hrefForReference=\{loaded\.codeSnapshotReference \? \(reference\) => \{/)
  assert.match(graphClient, /parsed\?\.kind === "document" && loaded\.codeSourceDocumentHref\) return loaded\.codeSourceDocumentHref/)
  assert.match(graphClient, /\} : fieldHrefForReference\}/)
  assert.match(graphClient, /onReferenceChange=\{onFieldReferenceChange\}/)
  assert.match(graphClient, /onSelectedReferenceChange\(reference \? safeCanonicalReference\(reference\) : null\)/)
  assert.match(graphClient, /selectedReferenceMissing/)
  assert.match(graphClient, /fieldProjection\.truncation\.omittedUnsupportedNodes > 0/)
  assert.match(graphClient, /fieldProjection\.truncation\.omittedDerivedNodes > 0/)
  assert.match(graphClient, /fieldProjection\.incompleteProviders\.map/)
  assert.match(graphClient, /Provider coverage is incomplete:/)
  assert.match(graphClient, /status,[\s\S]*fieldProjectionNotice,[\s\S]*fieldProviderNotice,[\s\S]*\.join\(" "\)/)
  assert.match(graphClient, /The requested object is not available in this authorized field\. No substitute was selected\./)
  assert.match(graphClient, /Bounded field:/)
  assert.doesNotMatch(graphClient, /className="sr-only" role="status">[\s\S]*Bounded field:/)
  assert.doesNotMatch(fieldRoute, /AtlasV2Loader|galaxy-brain|GalaxyBrain/)
})

test("field selections expose bounded stable references and deep links", async () => {
  const reference = await read("lib/galaxy-reference-codec.js")
  const field = await read("components/knowledge/semantic-field.tsx")

  assert.match(reference, /\^gb:\(entity\|node\):/)
  assert.match(reference, /encodeURIComponent\(normalized\)/)
  assert.match(reference, /decodeURIComponent\(match\[2\]\)/)
  assert.match(field, /aria-label="Selected object dock"/)
  assert.match(field, /Copy stable object reference/)
  assert.match(field, /Copy deep link to selected object/)
  assert.match(field, /selectedHasExactGraphLoader &&/)
  assert.match(field, /GRAPH_DEEP_LINK_KINDS = new Set\(\[[\s\S]*"ham\.memory"/)
  assert.match(field, /GRAPH_DEEP_LINK_KINDS = new Set\(\[[\s\S]*"eln\.observation"/)
  assert.match(field, /descendantCount: \(entry\.descendantCount \?\? 0\) \+ federatedProjection\.corpusStatementCount/)
  assert.match(field, /hrefForReference\?\.\(reference\) \?\? `\/graph\?ref=\$\{encodeURIComponent\(reference\)\}`/)
  assert.match(field, /Open source material/)
})

test("mobile Field controls reserve the lens rail footprint", async () => {
  const [field, graphClient] = await Promise.all([
    read("components/knowledge/semantic-field.tsx"),
    read("app/graph/graph-client.tsx"),
  ])

  assert.match(field, /footer className="semantic-field__chrome[^\"]*bottom-\[4\.75rem\]/)
  assert.doesNotMatch(field, /footer className="[^\"]*md:bottom-0/)
  assert.match(field, /absolute bottom-40 left-4/)
  assert.doesNotMatch(field, /bottom-40[^\"]*md:bottom-20/)
  assert.match(field, /dockPinned \? "top-40" : "bottom-\[9\.5rem\]"/)
  assert.match(graphClient, /shrink-0 border-b[\s\S]*role="status"/)
  assert.match(graphClient, /min-h-0 flex-1[\s\S]*<SemanticField/)
  assert.doesNotMatch(graphClient, /absolute[^"]*top-\[[^\]]+\][^"]*role="status"/)
})

test("interactive Field objects remain exposed to accessibility APIs", async () => {
  const field = await read("components/knowledge/semantic-field.tsx")

  assert.match(field, /<svg[\s\S]*role="group"[\s\S]*role="button"/)
  assert.doesNotMatch(field, /<svg[\s\S]*role="img"[\s\S]*role="button"/)
})

test("the retained Field component stays accessible without controlling the canonical Atlas route", async () => {
  const [field, route] = await Promise.all([
    read("components/knowledge/semantic-field.tsx"),
    read("app/workspace/page.tsx"),
  ])

  assert.match(field, /relative h-full min-h-0 overflow-hidden/)
  assert.match(route, /<AtlasV2Loader/)
  assert.doesNotMatch(route, /GalaxyBrain|searchParams|requestedView|requestedShell/)
})

test("the production Field lens copies canonical deep links within its own route", async () => {
  const [field, graphClient] = await Promise.all([
    read("components/knowledge/semantic-field.tsx"),
    read("app/graph/graph-client.tsx"),
  ])

  assert.match(field, /hrefForReference\?: \(reference: string\) => string/)
  assert.match(field, /onReferenceChange\?: \(reference: string \| null\) => void/)
  assert.match(field, /if \(onReferenceChange\) \{[\s\S]*onReferenceChange\(reference\)[\s\S]*return/)
  assert.match(field, /hrefForReference\?\.\(reference\) \?\? `\/graph\?ref=/)
  assert.match(graphClient, /return `\/field\?ref=\$\{encodeURIComponent\(reference\)\}`/)
})

test("Field search presents bounded source-specific results without score fusion", async () => {
  const field = await read("components/knowledge/semantic-field.tsx")

  assert.match(field, /maxLength=\{FIELD_SEARCH_QUERY_MAX\}/)
  assert.match(field, /max-h-\[min\(24rem,calc\(100dvh-11rem\)\)\]/)
  assert.match(field, /Galaxy · local field/)
  assert.match(field, /Local title\/content match · unscored/)
  assert.match(field, /HAM · durable memory/)
  assert.match(field, /HAM retrieval score · not comparable to Galaxy matching/)
  assert.match(field, /HAM search unavailable:/)
  assert.match(field, /aria-controls="semantic-field-search-results"/)
})

test("Field uses the shared living-research theme without reviving the navy product shell", async () => {
  const [styles, field, graphClient, preview] = await Promise.all([
    read("app/globals.css"),
    read("components/knowledge/semantic-field.tsx"),
    read("app/graph/graph-client.tsx"),
    read("app/dev/semantic-field-preview/page.tsx"),
  ])

  assert.match(styles, /\.semantic-field \{[\s\S]*--field-surface/)
  assert.match(styles, /--field-muted-strong:/)
  assert.match(styles, /--field-warm-strong:/)
  assert.match(styles, /--field-alert-strong:/)
  assert.match(styles, /--field-cool-strong:/)
  assert.match(field, /semantic-field research-workbench/)
  assert.match(field, /data-active=\{scaleIndex === index\}/)
  assert.match(field, /focus-visible:\[filter:drop-shadow\(0_0_4px_hsl\(var\(--field-core\)\)\)\]/)
  assert.match(field, /verified_proof: \{ color: "hsl\(var\(--field-core\)\)", width: 3\.5/)
  assert.match(field, /authored_assertion: \{ color: "hsl\(var\(--field-warm-strong\)\)", dash: "7 5"/)
  assert.match(field, /semantic_candidate: \{ color: "hsl\(var\(--field-muted-strong\)\)", dash: "2 7"/)
  assert.match(field, /aria-label=\{`Relations visible at \$\{SEMANTIC_SCALES\[scaleIndex\]\.label\} scale`\}/)
  assert.doesNotMatch(field, /#050812|#070a12|#0a101d|#0f1524|#59d7ff|#7be7ff/)
  assert.doesNotMatch(graphClient, /#07101c/)
  assert.match(preview, /research-workbench h-screen/)
})

test("ELN dashboard and record routes use the shared rail and account menu ownership", async () => {
  const [layout, dashboardPage, recordPage, dashboard, record] = await Promise.all([
    read("app/eln/layout.tsx"),
    read("app/eln/page.tsx"),
    read("app/eln/experiment/[id]/page.tsx"),
    read("components/eln/eln-dashboard.tsx"),
    read("components/eln/experiment-record.tsx"),
  ])

  assert.match(layout, /<AuthShell user=\{user\} ownsAccountMenu>/)
  assert.match(dashboardPage, /accountMenu=\{<AccountMenu user=\{user\} \/>\}/)
  assert.match(recordPage, /accountMenu=\{<AccountMenu user=\{user\} \/>\}/)
  assert.match(dashboard, /<TopRail lead=\{<TopRailTitle>ELN<\/TopRailTitle>\} accountMenu=\{accountMenu\} \/>/)
  assert.match(record, /<TopRail[\s\S]*accountMenu=\{accountMenu\}/)
})

test("ELN uses one token-driven rail and keeps every experiment state inside the living field", async () => {
  const [styles, dashboard, browser, record, drawer, attachment, hypotheses, hypothesisDialog, nav, theme, account, sheet] = await Promise.all([
    read("app/globals.css"),
    read("components/eln/eln-dashboard.tsx"),
    read("components/eln/experiment-browser.tsx"),
    read("components/eln/experiment-record.tsx"),
    read("components/eln/experiment-evidence-drawer.tsx"),
    read("components/eln/experiment-attachment-card.tsx"),
    read("components/eln/hypothesis-tracker.tsx"),
    read("components/eln/new-hypothesis-dialog.tsx"),
    read("components/workspace/galaxy-lens-nav.tsx"),
    read("components/theme-toggle.tsx"),
    read("components/account-menu.tsx"),
    read("components/ui/sheet.tsx"),
  ])

  assert.equal((record.match(/<TopRail\s/g) ?? []).length, 1)
  assert.match(record, /const recordRail = \([\s\S]*accountMenu=\{accountMenu\}/)
  assert.match(record, /if \(loading\)[\s\S]*research-workbench[\s\S]*\{recordRail\}/)
  assert.match(record, /if \(notFound\)[\s\S]*research-workbench[\s\S]*\{recordRail\}/)
  assert.match(record, /if \(loadError\)[\s\S]*research-workbench[\s\S]*\{recordRail\}/)
  assert.match(record, /<main className="research-workbench min-h-screen pb-28 md:pb-12">\s*\{recordRail\}/)
  assert.match(record, /flex w-full flex-wrap items-center gap-2 sm:w-auto/)
  assert.match(record, /overflow-x-auto[\s\S]*aria-label="Experiment metrics table"/)
  assert.match(record, /eln-table-scroll overflow-x-auto/)
  assert.match(dashboard, /research-workbench min-h-screen pb-28 md:pb-12/)

  assert.match(browser, /aria-busy=\{loading\}/)
  assert.match(browser, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(hypotheses, /overflow-x-auto[\s\S]*aria-label="Hypothesis table"/)
  assert.match(hypotheses, /eln-table-scroll overflow-x-auto/)
  assert.match(hypotheses, /aria-busy=\{loading\}/)
  assert.match(hypothesisDialog, /max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/)
  assert.match(drawer, /max-h-\[100dvh\][^\"]*overflow-y-auto/)
  assert.doesNotMatch(drawer, /className="dark|#0f1524|#070a12|#59d7ff|#9feaff|text-slate|border-white/)
  assert.doesNotMatch(attachment, /#070a12|text-slate/)

  const tokenDrivenSurfaces = [dashboard, browser, record, drawer, attachment, hypotheses, hypothesisDialog, nav, theme, account]
  for (const source of tokenDrivenSurfaces) {
    assert.doesNotMatch(source, /(?:bg|text|border)-\[#[0-9a-f]{3,8}\]/i)
  }
  assert.match(styles, /hsl\(var\(--research-warm\) \/ 0\.12\)/)
  assert.match(styles, /\.eln-table-scroll > div \{[\s\S]*overflow: visible;/)
  assert.match(styles, /\.auth-shell:has\(\.research-workbench\) \.auth-account-menu \{[\s\S]*var\(--research-line\)/)
  assert.match(nav, /min-h-11 min-w-11/)
  assert.match(theme, /min-h-11/)
  assert.match(account, /min-h-11/)
  assert.match(sheet, /min-h-11 min-w-11/)
})

test("Living Research muted text meets AA contrast on light ELN surfaces", async () => {
  const styles = await read("app/globals.css")
  const lightRoot = styles.match(/:root \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  const parseToken = (name) => {
    const match = lightRoot.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)%\\s+(\\d+)%`))
    assert.ok(match, `missing ${name}`)
    return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  const muted = parseToken("research-muted")
  const panel = parseToken("research-panel")
  const secondary = parseToken("research-accent-soft")
  assert.ok(contrastRatio(muted, panel) >= 4.5, "muted text must meet AA on the panel")
  assert.ok(contrastRatio(muted, secondary) >= 4.5, "muted text must meet AA on secondary surfaces")
})

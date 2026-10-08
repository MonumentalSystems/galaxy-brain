import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const componentPath = new URL("../components/graph/unified-graph.tsx", import.meta.url)
const workerPath = new URL("../workers/unified-graph-layout.worker.ts", import.meta.url)
const pagePath = new URL("../app/graph/page.tsx", import.meta.url)
const graphClientPath = new URL("../app/graph/graph-client.tsx", import.meta.url)
const corpusWindowPath = new URL("../components/graph/corpus-graph-window.tsx", import.meta.url)
const navPath = new URL("../components/workspace/galaxy-lens-nav.tsx", import.meta.url)

test("graph surface delegates force layout to a dedicated worker", async () => {
  const [component, worker] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(workerPath, "utf8"),
  ])
  assert.match(component, /new Worker\(new URL\("\.\.\/\.\.\/workers\/unified-graph-layout\.worker\.ts"/)
  assert.doesNotMatch(component, /forceSimulation|forceManyBody|\.tick\(/)
  assert.match(worker, /forceSimulation/)
  assert.match(worker, /GRAPH_LAYOUT_FORCE_LIMIT/)
  assert.match(worker, /deterministicGraphFallback/)
})

test("selection is canonical-reference based and survives semantic LOD", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /selectedReference/)
  assert.match(component, /node\.ref === selectedRef/)
  assert.doesNotMatch(component, /setInternalSelectedReference\(null\).*setScale/s)
  assert.match(component, /deriveUnifiedGraphView/)
  assert.doesNotMatch(component, /visibleAtScale/)
  for (const scale of ["corpus", "project", "task", "run", "object", "atomic"]) {
    assert.match(component, new RegExp(`\\b${scale}\\b`))
  }
})

test("semantic scale follows later deep-link props and exposes owner navigation without losing local LOD", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /const semanticScale = initialScale \|\| projection\.query\.scale/)
  assert.match(component, /useState<GraphScale>\(semanticScale\)/)
  assert.match(component, /setScale\(\(current\) => current === semanticScale \? current : semanticScale\)/)
  assert.match(component, /}, \[semanticScale\]\)/)
  assert.match(component, /onScaleChange\?: \(scale: GraphScale\) => void/)
  assert.match(component, /setScale\(nextScale\)[\s\S]*onScaleChange\?\.\(nextScale\)/)
  assert.match(component, /onClick=\{\(\) => selectScale\(item\)\}/)
  assert.doesNotMatch(component, /\[semanticScale, scale\]/)
})

test("proof corpus handoff preserves exact focus and returns through a screen-space control", async () => {
  const [component, graphClient, corpus] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(graphClientPath, "utf8"),
    readFile(corpusWindowPath, "utf8"),
  ])
  assert.match(graphClient, /proofGraphReference: string \| null/)
  assert.match(graphClient, /planProofCorpusScaleNavigation\(currentHref, scale, loaded\?\.proofGraphReference\)/)
  assert.match(graphClient, /parameters\.get\("corpusWindow"\) === "1"/)
  assert.match(graphClient, /proofGraphReturnHref\(currentHref, focusReference\)/)
  assert.match(graphClient, /focusReturnHref=\{corpusFocusReturnHref\}/)
  assert.match(graphClient, /onScaleChange=\{changeGraphScale\}/)
  assert.match(graphClient, /url\.searchParams\.delete\("focus"\)[\s\S]*url\.searchParams\.delete\("corpusWindow"\)/)
  assert.match(corpus, /window\.focus && focusReturnHref/)
  assert.match(corpus, /Return to focused proof graph/)
  assert.match(corpus, /className="min-h-11"/)
  const svgStart = corpus.indexOf("<svg")
  const svgEnd = corpus.indexOf("</svg>", svgStart)
  assert.ok(svgStart >= 0 && svgEnd > svgStart)
  assert.doesNotMatch(corpus.slice(svgStart, svgEnd), /<button|role="button"|<a\b/u)
  assert.match(component, /onScaleChange\?\.\(nextScale\)/)
})

test("graph has an accessible list, exact-reference link, trust labels, and reduced-motion styles", async () => {
  const [component, graphClient] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(graphClientPath, "utf8"),
  ])
  assert.match(component, /graph-accessible-list/)
  assert.match(component, /Readable relation summary/)
  assert.match(component, /Open exact reference/)
  assert.match(component, /\/graph\?ref=/)
  assert.doesNotMatch(component, /\/workspace\?ref=/)
  assert.doesNotMatch(component, /\/workspace\?view=/)
  assert.match(graphClient, /canonicalGraphQueryParameter\(new URLSearchParams\(search\), "ref"\)/)
  assert.match(graphClient, /loadAuthorizedGraph\(tenantId, routeSearch, controller\.signal, codeGraphClientRef\.current/)
  assert.match(component, /Projection, not authority/)
  assert.match(component, /motion-reduce:transition-none/)
  assert.match(component, /data-trust-class/)
  assert.match(component, /aria-label=\{graphNodeAccessibleLabel\(node\)\}/)
  assert.match(component, /projectorAvailabilityText\(node\)/)
  assert.match(component, /Projector unavailable/)
  assert.match(component, />Source provenance</)
  assert.match(component, />Projector</)
  assert.match(component, /projectorInspectorText\(selected\)/)
  assert.match(component, /plugin\.displayName} · \$\{plugin\.id}@\$\{plugin\.version/)
  assert.match(component, /No registered code-owned projector handles this object kind\./)
  assert.doesNotMatch(component, /installed|connected|healthy|credential/iu)
})

test("an eligible surface gets one exact Generous viewer action instead of a graph self-link", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /exactGenerousSurfaceHref\(selected\)/)
  assert.match(component, /href=\{exactGenerousSurfaceDestination\}/)
  assert.match(component, /Open exact Generous surface/)
  assert.match(component, /selected\.kind === "surface"/)
  assert.match(component, /does not expose a valid exact Generous viewer destination/)
  assert.match(component, /\) : selected\.ref \? \(/)
})

test("bare chat references use the federated graph route while explicit conversation routes retain the tree", async () => {
  const graphClient = await readFile(graphClientPath, "utf8")
  assert.match(graphClient, /resolveConversationGraphRoute\(\{/)
  assert.match(graphClient, /conversationReference,\s*mode: query\.mode,/)
  assert.doesNotMatch(graphClient, /requestedKind === "chat"/)
})

test("exact conversation Markdown export appears only on the selected chat root", async () => {
  const [component, graphClient] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(graphClientPath, "utf8"),
  ])
  assert.match(component, /selected\.kind === "chat"/)
  assert.match(component, /conversationExport\?\.conversationReference === selected\.ref/)
  assert.match(component, /Download exact Markdown/)
  assert.match(component, /aria-describedby="conversation-export-availability"/)
  assert.match(component, /System and tool bodies, artifacts, provenance, runs, logs, and live state remain excluded\./)
  assert.doesNotMatch(component, /target="_blank"/)
  assert.match(graphClient, /conversationNode\.projection\.revision\.id !== loaded\.conversationContentHash/)
  assert.match(graphClient, /loaded\.conversationHasMore[\s\S]*CONVERSATION_TURN_LIMIT\}-turn portable bound/)
  assert.match(graphClient, /conversationExport=\{conversationExport \? \{/)
  assert.match(graphClient, /conversationExportGenerationRef\.current \+= 1/)
  assert.match(graphClient, /conversationExportControllerRef\.current\?\.abort\(\)/)
  assert.match(graphClient, /fetchConversationMarkdownExport\(reference, \{ signal: controller\.signal \}\)[\s\S]*generation !== conversationExportGenerationRef\.current[\s\S]*saveConversationMarkdownExport\(exported\)/)
  assert.match(graphClient, /useEffect\(\(\) => \(\) => \{[\s\S]*conversationExportControllerRef\.current\?\.abort\(\)/)
})

test("conversation joins require the selected exact tip plus explicit eligible tips", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /conversationJoin\?: Readonly</)
  assert.match(component, /selected\.ref === conversationJoin\?\.selectedTipReference/)
  assert.match(component, /candidate\.reference === conversationJoin\.selectedTipReference/)
  assert.match(component, /joinSelectionKey = `\$\{projection\.projectionHash\}\\u0000\$\{conversationJoin\?\.selectedTipReference/)
  assert.match(component, /joinSelection\.key === joinSelectionKey[\s\S]*: \[\]/)
  assert.match(component, /Keep this selected tip and explicitly choose one to seven other branch tips\. Nothing is selected automatically\./)
  assert.match(component, /type="checkbox" checked disabled aria-label=\{`Selected tip:[^`]+exact reference/)
  assert.match(component, /Include tip:[^`]+exact reference/)
  assert.match(component, /disabled=\{!checked && joinSelectionIsFull\}/)
  assert.match(component, /currentReferences\.length >= 7/)
  assert.doesNotMatch(component, /conversationJoin[^\n]*candidates\.slice\(/)
  assert.match(component, /disabled=\{selectedJoinTipCount < 2 \|\| Boolean\(conversationJoin\.disabledReason\)\}/)
  assert.match(component, /aria-describedby="conversation-join-help conversation-join-status"/)
  assert.match(component, /role="status" aria-live="polite"/)
  assert.match(component, /\[selectedJoinTip\.reference, \.\.\.selectedAdditionalJoinTips\.map/)
  assert.match(component, /\[selectedJoinTip\.title, \.\.\.selectedAdditionalJoinTips\.map/)
  assert.match(component, /<GitMerge[^>]+\/> Join selected tips/)
})

test("the interactive graph exposes structured SVG controls instead of flattening them as an image", async () => {
  const component = await readFile(componentPath, "utf8")
  const svgStart = component.indexOf("<svg")
  const svgEnd = component.indexOf("</svg>", svgStart)
  assert.ok(svgStart >= 0 && svgEnd > svgStart)
  const interactiveSvg = component.slice(svgStart, svgEnd)

  assert.match(interactiveSvg, /role=\{"graphics-document document" as AriaRole\}/)
  assert.doesNotMatch(interactiveSvg, /role="img"/)
  assert.match(interactiveSvg, /role="button"/)
  assert.match(interactiveSvg, /tabIndex=\{0\}/)
  assert.match(interactiveSvg, /aria-pressed=\{active\}/)
  assert.match(interactiveSvg, /event\.key === "Enter" \|\| event\.key === " "/)
})

test("Graph renderers use shared living-research tokens without erasing trust cues", async () => {
  const [component, corpus, conversation, client, page, preview, styles] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(corpusWindowPath, "utf8"),
    readFile(new URL("../components/graph/conversation-browser.tsx", import.meta.url), "utf8"),
    readFile(graphClientPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(new URL("../app/dev/unified-graph-preview/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ])

  assert.match(page, /research-workbench min-h-screen/)
  assert.match(preview, /research-workbench min-h-screen/)
  assert.match(component, /graph-surface relative/)
  assert.match(corpus, /graph-surface overflow-hidden/)
  assert.match(conversation, /graph-surface rounded-2xl/)
  assert.match(styles, /\.graph-surface \{/)
  assert.match(styles, /--graph-warm-edge: 34 60% 30%/)
  assert.match(styles, /\.graph-surface__card\[aria-pressed="true"\]/)
  assert.match(styles, /\.graph-surface__focus:focus-visible/)
  assert.match(component, /dash: "7 5"/)
  assert.match(component, /dash: "2 7"/)
  assert.match(component, /case "verification": return \{ color: GRAPH_COLOR\.core, width: 2\.5/)
  assert.match(component, /case "assertion": return \{ color: GRAPH_COLOR\.cool, width: 1\.8/)
  assert.match(component, /warm: "hsl\(var\(--graph-warm-edge\)\)"/)
  assert.match(component, /case "candidate": return \{ color: GRAPH_COLOR\.warm, width: 1\.4/)
  assert.match(component, /opacity="0\.72"/)
  assert.match(component, /graphKind === "repository-field"\) return GRAPH_COLOR\.core/)
  assert.doesNotMatch(component, /nodeState\?\.verification\) return GRAPH_COLOR/)
  assert.match(component, /data-trust-class=\{edge\.trust\}/)
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}/i)
  assert.doesNotMatch(corpus, /#[0-9a-f]{3,8}/i)
  assert.doesNotMatch(conversation, /#[0-9a-f]{3,8}/i)
  assert.doesNotMatch(client, /#[0-9a-f]{3,8}/i)
  assert.doesNotMatch(page, /#[0-9a-f]{3,8}/i)
  assert.doesNotMatch(preview, /#[0-9a-f]{3,8}/i)
})

test("text filtering does not change the projection-hash layout input", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /useGraphLayout\(projection, semanticNodes, semanticEdges, scale\)/)
  assert.match(component, /!conversationMode \|\| scale === "corpus" \|\| edge\.relation !== "contains"/)
  assert.doesNotMatch(component, /useGraphLayout\(projection, visibleNodes, visibleEdges, scale\)/)
})

test("proof inspector reveals only authorized coordinated HAM task summaries", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, /coordinationTasks\?: readonly TaskSummary\[\]/)
  assert.match(component, /edge\.from === proofNode\.id && edge\.relation === "coordinated_by"/)
  assert.match(component, /taskNode\?\.kind !== "ham\.task" \|\| taskNode\.projection\.provenance\.sourceId !== taskId/)
  assert.match(component, /Primary linked HAM task ID/)
  assert.match(component, /Linked HAM task count/)
  const validatedTaskBranch = component.indexOf("{linkedHamTask ? (")
  assert.ok(validatedTaskBranch >= 0)
  assert.ok(component.indexOf("Primary linked HAM task ID") > validatedTaskBranch)
  assert.ok(component.indexOf("Linked HAM task count") > validatedTaskBranch)
  for (const field of ["State", "Stage", "Owner", "Active run", "Version"]) {
    assert.match(component, new RegExp(`>${field}<`))
  }
  assert.match(component, /Select linked HAM task/)
  assert.match(component, /paperTaskConstructorHref\(\{ id: task\.id, version \}\)/)
  assert.match(component, /Number\.isSafeInteger\(version\)/)
  assert.match(component, /linkedTaskConstructorHref \?/)
  assert.match(component, /href=\{linkedTaskConstructorHref\}/)
  assert.match(component, /Open Task Constructor/)
  assert.doesNotMatch(component, /Open linked HAM task/)
  assert.doesNotMatch(component, /href=\{hrefForReference\(linkedHamTask\.node\.ref\)\}/)
  assert.match(component, /Linked HAM task not loaded\./)
})

test("proof inspector keeps HAM coordination separate from Lean verification", async () => {
  const component = await readFile(componentPath, "utf8")
  assert.match(component, />HAM coordination</)
  assert.match(component, />Lean verification</)
  assert.match(component, /Agents claim this work through HAM\./)
  assert.match(component, /HAM task completion does not verify this Lean proof\./)
  assert.doesNotMatch(component, /claimTask|createClaim|claim endpoint/i)
})

test("authenticated Graph lens is production-addressable through authorized sources without demo data", async () => {
  const [page, client, nav] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(graphClientPath, "utf8"),
    readFile(navPath, "utf8"),
  ])
  assert.match(page, /await requireUser\(\)/)
  assert.match(page, /GraphClient key=\{user\.tenantId\} tenantId=\{user\.tenantId\}/)
  assert.match(client, /buildAuthorizedGraphSource/)
  assert.match(client, /fetchTaskSnapshot/)
  assert.match(client, /buildAuthorizedTaskPlanGraphSource/)
  assert.match(client, /\/api\/eln\/task-plans\?limit=/)
  assert.match(client, /\/api\/eln\/task-plans\?ham_task_id=\$\{encodeURIComponent\(taskId\)\}&limit=1/)
  assert.match(client, /Authorized Task Plan does not contain the requested immutable revision/)
  assert.match(client, /requestedTaskPlanPriorityReferences/)
  assert.match(client, /taskPlanSource\.graphInput/)
  assert.doesNotMatch(client, /\/api\/eln\/task-plans\/[^`"']+\/dispatch-intents/)
  assert.match(client, /PROOF_TASK_HYDRATION_LIMIT = 64/)
  assert.match(client, /fetchTaskDetail\(taskId, signal\)/)
  assert.match(client, /validated\.relations\.length === 0/)
  assert.match(client, /new Map\(rawTaskInputs\.map\(\(entry\) => \[entry\.task\.id, entry\]\)\)/)
  assert.match(client, /\/api\/eln\/papers\?limit=/)
  assert.match(client, /\/api\/eln\/object-links\?/)
  assert.match(client, /\/api\/eln\/surfaces\?status=promoted&limit=/)
  assert.match(client, /\/api\/eln\/surfaces\/contract/)
  assert.match(client, /value\.schema_digest === contract\.digests\.schema/)
  assert.match(client, /isCompatibleSurfaceCatalogDigest\(value\.catalog_digest\)/)
  assert.match(client, /value\.renderer_version === contract\.catalog\.renderer\.version/)
  assert.match(client, /resolveObjectProjectionReferences/)
  assert.match(client, /isGraphGatewayProjectionReference/)
  assert.match(client, /selectMissingLinkedProjectionReferences/)
  assert.match(client, /loadExactGraphSource/)
  assert.match(client, /candidate\.metadata_hash\.toLowerCase\(\)/)
  assert.match(client, /projections: \[\.\.\.projectionByReference\.values\(\)\]/)
  assert.match(client, /provider\(scope, "galaxy\.surface",/)
  // Constant placeholders kept the Field coverage notice from ever clearing.
  assert.doesNotMatch(client, /provider\(scope, "(?:generous\.a2ui|federated-expansion)", "unavailable"\)/)
  assert.match(client, /buildAuthorizedProofGraphSource/)
  assert.match(client, /joinAuthorizedProofHamCoordination/)
  assert.match(client, /bindings: proofSource\.coordinationBindings/)
  assert.match(client, /relations: \[\.\.\.coordination\.relations\]/)
  assert.match(client, /coordinationTasks=\{loaded\.coordinationTasks\}/)
  assert.match(client, /normalizeProofGraphList/)
  assert.match(client, /crypto\.subtle\.digest\("SHA-256"/)
  assert.match(client, /PROOF_GRAPH_SELECTION_EVENT/)
  assert.match(client, /explicitProof\.contentSha256 \|\| explicitProof\.workspaceId/)
  assert.match(client, /Requested proof graph reference does not match the selected immutable graph/)
  assert.match(client, /parseGalaxyObjectReference\(reference\)\?\.kind === "proof\.node"/)
  assert.match(client, /sourceLimit: Math\.min\(513, sourceLimit\)/)
  assert.match(client, /projection\.continuation\.hasMore \|\| projection\.continuation\.reasons\.length > 0/)
  assert.match(client, /Authorized source returned a different object reference/)
  assert.match(client, /No demo or cross-workspace data has been substituted/)
  assert.match(nav, /href: "\/graph"/)
})

test("bounded corpus navigation is mixed-only, tenant-keyed, and exposes screen-space controls", async () => {
  const [page, client, corpus] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(graphClientPath, "utf8"),
    readFile(corpusWindowPath, "utf8"),
  ])
  assert.match(page, /GraphClient key=\{user\.tenantId\}/)
  assert.match(client, /WINDOW_MODES = new Set\(\["mixed"\]\)/)
  assert.match(corpus, /<ul className="grid grid-cols-1/)
  assert.match(corpus, /min-h-11 w-full/)
  assert.doesNotMatch(corpus, /<foreignObject[\s\S]*<button/u)
  const svgStart = corpus.indexOf("<svg")
  const svgEnd = corpus.indexOf("</svg>", svgStart)
  assert.ok(svgStart >= 0 && svgEnd > svgStart)
  const overviewSvg = corpus.slice(svgStart, svgEnd)
  assert.match(overviewSvg, /role="img"/)
  assert.doesNotMatch(overviewSvg, /<button|role="button"/)
  assert.ok(corpus.indexOf("<button", svgEnd) > svgEnd)
})

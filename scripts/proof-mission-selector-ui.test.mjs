import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const componentUrl = new URL("../components/graph/proof-mission-selector.tsx", import.meta.url)

test("mission selector emits explicit immutable intent without live state", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /schemaId: "galaxy\.proof-mission-selection\.v1"/u)
  assert.match(source, /missionId: string/u)
  assert.match(source, /const MISSION_ID = \/\^\[A-Za-z0-9\]/u)
  assert.match(source, /normalizedMissionId/u)
  assert.match(source, /Object\.freeze\(\{[\s\S]*milestoneIds: Object\.freeze/u)
  assert.match(source, /onSubmit=\{submitSelection\}/u)
  assert.match(source, /onSelection\(freezeSelection/u)
  assert.match(source, /proofDag\.graphKind === "repository-field"/u)
  assert.match(source, /does not create a workspace, claims, runs, or verification state/u)
  assert.match(source, /Selection is intent only; activation is a separate, explicit step/u)
  assert.doesNotMatch(source, /fetch\(|\/api\/|ProofWorkState|claimable/u)
})

test("mission selector previews the prerequisite closure and non-operational structural roots", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /pending\.push\(\.\.\.node\.prerequisiteNodeIds\)/u)
  assert.match(source, /closureIds\.add\(nodeId\)/u)
  assert.match(source, /node\.prerequisiteNodeIds\.every/u)
  assert.match(source, /Read-only structure preview/u)
  assert.match(source, /Prerequisite closure/u)
  assert.match(source, /Structural roots/u)
  assert.match(source, /not a proof or claim state/u)
  assert.match(source, /PREVIEW_RENDER_LIMIT/u)
  assert.match(source, /Showing the first/u)
})

test("mission selector uses native form controls and accessible touch targets", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /<section[\s\S]*aria-labelledby/u)
  assert.match(source, /<form[\s\S]*onSubmit/u)
  assert.match(source, /<label htmlFor=\{mainTheoremId\}/u)
  assert.match(source, /<label htmlFor=\{missionIdField\}/u)
  assert.match(source, /pattern="\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,119\}"/u)
  assert.match(source, /maxLength=\{120\}/u)
  assert.match(source, /<select[\s\S]*required[\s\S]*aria-describedby/u)
  assert.match(source, /<fieldset/u)
  assert.match(source, /<legend/u)
  assert.match(source, /type="checkbox"/u)
  assert.match(source, /aria-live="polite"/u)
  assert.match(source, /role="alert"/u)
  assert.match(source, /min-h-11/u)
  assert.match(source, /focus-visible:/u)
  assert.doesNotMatch(source, /<(?:div|span)[^>]*onClick=/u)
})

test("bounded mission strings wrap instead of clipping on narrow presenters", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /graph-surface__control flex min-h-11 min-w-0/u)
  assert.match(source, /<div className="min-w-0">[\s\S]*proofDag\.title/u)
  assert.match(source, /max-w-3xl break-words/u)
  assert.match(source, /<span className="min-w-0"><span className="block break-words font-medium">\{node\.title\}/u)
  assert.match(source, /block break-all font-mono/u)
  assert.match(source, /preview\.closure[\s\S]*min-w-0[\s\S]*block break-words font-medium/u)
  assert.match(source, /preview\.frontier[\s\S]*min-w-0[\s\S]*block break-words font-medium/u)
})

test("only terminal targets are offered as main mission goals", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /const terminal = proofDag\.nodes\.filter\(\(node\) => !prerequisiteSources\.has\(node\.nodeId\)\)/u)
  assert.match(source, /terminal\.filter\(\(node\) => node\.targetKind === "theorem"\)/u)
  assert.match(source, /Suggested terminal theorems/u)
  assert.match(source, /Other formal targets/u)
})

test("milestones are constrained to the selected theorem closure", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /preview\.closure[\s\S]*node\.nodeId !== selectedMainTheoremId/u)
  assert.match(source, /selectedMilestoneIds\.filter\(\(nodeId\) => allowedMilestones\.has\(nodeId\)\)/u)
  assert.match(source, /MILESTONE_OF/u)
})

test("every user edit invalidates a previously compiled parent draft", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /onDraftInvalidated\?: \(\) => void/u)
  assert.match(source, /onDraftInvalidated\?\.\(\)[\s\S]*setMissionId\(event\.target\.value\)/u)
  assert.match(source, /onDraftInvalidated\?\.\(\)[\s\S]*setSelectedMainTheoremId\(nextMainTheoremId\)/u)
  assert.match(source, /function toggleMilestone[\s\S]*onDraftInvalidated\?\.\(\)[\s\S]*setSelectedMilestoneIds/u)
})

test("only a server-acknowledged candidate clears mission draft discard risk", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /acknowledgedSelection\?: Pick<ProofMissionSelection/u)
  assert.match(source, /const acknowledgedDraftKey = acknowledgedSelection/u)
  assert.match(source, /hasDraftInput && draftKey !== acknowledgedDraftKey/u)
  assert.doesNotMatch(source, /setConfirmedDraftKey/u)
  assert.doesNotMatch(source, /mainTheoremFilter\.trim\(\)[\s\S]*hasDraftInput/u)
})

test("large closures and milestone controls remain explicitly bounded", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /PROOF_MISSION_COMPILER_LIMITS/u)
  assert.match(source, /const MILESTONE_CONTROL_LIMIT = Math\.min\(120, PROOF_MISSION_COMPILER_LIMITS\.milestones\)/u)
  assert.match(source, /allMilestoneCandidates\.slice\(0, MILESTONE_CONTROL_LIMIT\)/u)
  assert.match(source, /omittedMilestoneCandidateCount/u)
  assert.match(source, /omitted from these controls; the compiler still validates the complete prerequisite closure/u)
  assert.match(source, /preview\.closure\.length > PROOF_MISSION_COMPILER_LIMITS\.targets/u)
  assert.match(source, /exceeding the compiler limit/u)
  assert.match(source, /disabled=\{[^}]*closureExceedsCompilerLimit/u)
})

test("terminal goal search scans the corpus but renders a bounded native select", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /const GOAL_OPTION_LIMIT = 120/u)
  assert.match(source, /type="search"/u)
  assert.match(source, /node\.nodeId\.toLowerCase\(\)\.includes\(normalizedGoalFilter\)/u)
  assert.match(source, /node\.title\.toLowerCase\(\)\.includes\(normalizedGoalFilter\)/u)
  assert.match(source, /matchesWithoutSelected\.slice\(0, availableMatchSlots\)/u)
  assert.match(source, /matching targets are omitted from this bounded control/u)
  assert.match(source, /<select/u)
  assert.doesNotMatch(source, /onChange=\{\(event\) => \{\s*onDraftInvalidated\?\.\(\)\s*setMainTheoremFilter/u)
})

test("terminal goal filtering preserves the selected target and invalidates only target changes", async () => {
  const source = await readFile(componentUrl, "utf8")

  assert.match(source, /const selected = allGoalCandidates\.find\(\(node\) => node\.nodeId === selectedMainTheoremId\)/u)
  assert.match(source, /selected\s*\? \[selected, \.\.\.matchesWithoutSelected\.slice\(0, availableMatchSlots\)\]/u)
  assert.match(source, /current selection remains available even though it does not match this filter/u)
  assert.match(source, /if \(nextMainTheoremId === selectedMainTheoremId\) return/u)
  assert.match(source, /onDraftInvalidated\?\.\(\)[\s\S]*setSelectedMainTheoremId\(nextMainTheoremId\)/u)
})

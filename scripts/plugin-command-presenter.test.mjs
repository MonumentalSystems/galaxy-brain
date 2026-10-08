import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("Atlas command presenters are a closed static host with no authority of its own", async () => {
  const [host, atlas] = await Promise.all([
    readFile(new URL("../components/atlas/atlas-command-presenter-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])

  assert.match(host, /import \{ AtlasCanvasCreateDialog \} from "@\/components\/atlas\/atlas-canvas-create-dialog"/)
  assert.match(host, /import \{ AtlasFrameDialog \} from "@\/components\/atlas\/atlas-frame-dialog"/)
  assert.match(host, /import \{ CodeEditorDialog \} from "@\/components\/code\/code-editor-dialog"/)
  assert.match(host, /import \{ CodeGraphSnapshotImportDialog \} from "@\/components\/atlas\/code-graph-snapshot-import-dialog"/)
  assert.match(host, /import \{ NewExperimentDialog \} from "@\/components\/eln\/new-experiment-dialog"/)
  assert.match(host, /import \{ VoiceCaptureDialog \} from "@\/components\/voice\/voice-capture-dialog"/)
  assert.match(host, /import \{ TaskConstructorDialog \} from "@\/components\/tasks\/task-constructor-dialog"/)
  assert.match(host, /type CanvasPresenterProps = Omit</)
  assert.match(host, /type ElnPresenterProps = Pick</)
  assert.match(host, /type CodePresenterProps = Pick</)
  assert.match(host, /type CodeGraphPresenterProps = Pick</)
  assert.match(host, /\| "preset"/)
  assert.match(host, /type VoicePresenterProps = Pick</)
  assert.match(host, /type TaskPresenterProps = Pick</)
  assert.doesNotMatch(host, /"initialDraft"|"proposalCandidate"|"onProposalDecision"/)
  assert.match(host, /returnFocus: HTMLElement \| null/)
  assert.match(host, /fallbackFocus: HTMLElement \| null/)
  assert.match(host, /canvas: CanvasPresenterProps \| null/)
  assert.match(host, /eln: ElnPresenterProps/)
  assert.match(host, /code: CodePresenterProps \| null/)
  assert.match(host, /codeGraph: CodeGraphPresenterProps \| null/)
  assert.match(host, /voice: VoicePresenterProps \| null/)
  assert.match(host, /task: TaskPresenterProps/)
  assert.match(host, /navigateOnCreated=\{false\}/)
  assert.equal(host.match(/returnFocus=\{returnFocus\}/g)?.length, 6)
  assert.equal(host.match(/fallbackFocus=\{fallbackFocus\}/g)?.length, 7)
  assert.equal(host.match(/<AtlasCanvasCreateDialog/g)?.length, 1)
  assert.equal(host.match(/<AtlasFrameDialog/g)?.length, 1)
  assert.equal(host.match(/<NewExperimentDialog/g)?.length, 1)
  assert.equal(host.match(/<CodeEditorDialog/g)?.length, 1)
  assert.equal(host.match(/<CodeGraphSnapshotImportDialog/g)?.length, 1)
  assert.equal(host.match(/<VoiceCaptureDialog/g)?.length, 1)
  assert.equal(host.match(/<TaskConstructorDialog/g)?.length, 1)
  assert.doesNotMatch(host, /children|ComponentType|implementationId|registry|dispatch|module|https?:|\bfetch\s*\(|\bimport\s*\(|\beval\s*\(|new Function|galaxyBrainAPI|useState|useEffect|localStorage|sessionStorage/)

  assert.equal(atlas.match(/<AtlasCommandPresenterHost/g)?.length, 1)
  assert.doesNotMatch(atlas, /import \{ NewExperimentDialog \}|import \{ CodeEditorDialog|import \{ VoiceCaptureDialog/)
  assert.doesNotMatch(atlas, /import \{ TaskConstructorDialog \}/)
  assert.match(atlas, /onCreated: placeCreatedExperiment/)
  assert.match(atlas, /onSave: codeEditorPreset === "markdown-note" \? saveMarkdownNoteAndPlace : saveCodeAndPlace/)
  assert.match(atlas, /onSave: saveVoiceAndPlace/)
  for (const callback of [
    "changeVoiceCaptureOpen",
    "retryImportedVoicePlacement",
    "abandonVoiceSave",
    "editVoiceDraft",
  ]) {
    assert.match(atlas, new RegExp(`: ${callback}[,\\n]`))
  }
  for (const callbacks of [
    ["changeMarkdownNoteOpen", "changeCodeEditorOpen"],
    ["saveMarkdownNoteAndPlace", "saveCodeAndPlace"],
    ["retryMarkdownNotePlacement", "retryImportedCodePlacement"],
    ["abandonMarkdownNote", "abandonCodeSave"],
    ["editMarkdownNote", "editCodeDraft"],
  ]) {
    assert.match(atlas, new RegExp(`${callbacks[0]}[\\s\\S]*${callbacks[1]}`))
  }
  assert.match(atlas, /const executeSelectedAtlasCommand = useCallback\(\([\s\S]*trigger: HTMLElement \| null = commandTriggerRef\.current/)
  assert.match(atlas, /commandPresenterReturnFocusRef\.current = trigger\?\.isConnected \? trigger : commandTriggerRef\.current/)
  assert.match(atlas, /returnFocus=\{commandPresenterReturnFocusRef\.current\?\.isConnected[\s\S]*\? commandPresenterReturnFocusRef\.current[\s\S]*: commandTriggerRef\.current\}/)
  assert.match(atlas, /fallbackFocus=\{atlasHeadingRef\.current\}/)
  assert.match(atlas, /<h1 ref=\{atlasHeadingRef\} tabIndex=\{-1\} className="[^"]*focus-visible:ring-2/)
  assert.match(atlas, /code=\{codeDraftScope \? \{/)
  assert.match(atlas, /codeGraph=\{\{/)
  assert.match(atlas, /preset: codeEditorPreset/)
  assert.match(atlas, /voice=\{codeDraftScope \? \{/)
  assert.match(atlas, /task=\{\{[\s\S]*task: constructorTask,[\s\S]*returnFocus: constructorReturnFocus,[\s\S]*mode: preview \? "preview" : "live"/)
  assert.match(atlas, /event\.defaultPrevented[\s\S]*\|\| constructorOpen[\s\S]*\) return/)
  assert.match(atlas, /const executeTaskCommand = useCallback\([\s\S]*setCommandDeckOpen\(false\)[\s\S]*trigger\?\.isConnected \? trigger : commandTriggerRef\.current[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*setConstructorTask\(taskSnapshot\)[\s\S]*setConstructorReturnFocus\(returnFocus\)[\s\S]*setConstructorOpen\(true\)/)
})

test("Atlas Create menu projects registered commands without a second router", async () => {
  const [menu, atlas] = await Promise.all([
    readFile(new URL("../components/atlas/atlas-create-menu.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])

  assert.match(atlas, /const createHudCommands = atlasCommands\.filter\([\s\S]*command\.hudGroup === "create"/u)
  assert.match(atlas, /createHudCommands\.length > 0 \? \([\s\S]*<AtlasCreateMenu/u)
  assert.match(atlas, /onSelect=\{\(command\) => executeSelectedAtlasCommand\(command\.id, createHudTriggerRef\.current\)\}/u)
  assert.match(menu, /if \(commands\.length === 0\) return null/u)
  assert.match(menu, /<DropdownMenuTrigger asChild>[\s\S]*<HudAction ref=\{ref\} label="Create" icon=\{<Plus \/>\} \/>/u)
  assert.match(menu, /<DropdownMenuContent[\s\S]*sideOffset=\{8\}[\s\S]*collisionPadding=\{12\}/u)
  assert.match(menu, /max-h-\[calc\(100dvh-1\.5rem\)\] w-\[calc\(100vw-1\.5rem\)\] max-w-80 overflow-y-auto/u)
  assert.match(menu, /commands\.map\(\(command\) => \(/u)
  assert.match(menu, /disabled=\{!command\.enabled\}/u)
  assert.match(menu, /onSelect=\{\(\) => \{ if \(command\.enabled\) onSelect\(command\) \}\}/u)
  assert.match(menu, /command\.unavailableReason/u)
  assert.match(menu, /\{command\.title\}/u)
  assert.match(menu, /command\.description/u)
  assert.doesNotMatch(menu, /document\.import|paper\.import|eln\.experiment\.create|ink\.draw\.open|code\.editor\.open|web\.capture\.open/u)
  assert.doesNotMatch(menu, /dispatchAtlasCommand|window\.location|setDocumentImportOpen|setPaperImportOpen|setExperimentCreateOpen|setInkDrawingOpen|setCodeEditorOpen|setWebCaptureOpen/u)

  for (const dialogName of [
    "InkDrawingDialog",
    "WebCaptureDialog",
    "ArxivPaperImportDialog",
    "DocumentImportDialog",
  ]) {
    assert.match(
      atlas,
      new RegExp(`<${dialogName}[\\s\\S]*?returnFocus=\\{commandPresenterReturnFocusRef\\.current\\?\\.isConnected[\\s\\S]*?\\? commandPresenterReturnFocusRef\\.current[\\s\\S]*?: commandTriggerRef\\.current\\}`),
    )
  }
})

test("Atlas command presenters share dark-safe tokens, mobile reflow, and connected focus fallback", async () => {
  const [canvas, eln, code, voice, focus, styles] = await Promise.all([
    readFile(new URL("../components/atlas/atlas-canvas-create-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/new-experiment-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/code/code-editor-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/voice/voice-capture-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/presenter-focus.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ])

  for (const presenter of [eln, code, voice]) {
    assert.match(presenter, /atlas-command-presenter research-workbench/)
    assert.match(presenter, /fallbackFocus\?: HTMLElement \| null/)
    assert.match(presenter, /focusFirstConnected\(\[returnFocus, fallbackFocus\], contentRef\.current\)/)
    assert.match(presenter, /w-\[calc\(100vw-1rem\)\]/)
    assert.doesNotMatch(presenter, /#[0-9a-f]{3,8}|rgba?\(/iu)
    assert.doesNotMatch(presenter, /text-destructive|text-muted-foreground/)
    assert.match(presenter, /AlertDialogDescription className="atlas-command-presenter__muted"/)
  }
  assert.match(canvas, /returnFocus: HTMLElement \| null/)
  assert.match(canvas, /fallbackFocus: HTMLElement \| null/)
  assert.match(canvas, /focusFirstConnected\(\[returnFocus, fallbackFocus\], contentRef\.current\)/)
  assert.match(canvas, /atlas-command-presenter research-workbench/)
  assert.match(canvas, /w-\[calc\(100vw-1rem\)\]/)
  assert.doesNotMatch(canvas, /#[0-9a-f]{3,8}|rgba?\(/iu)
  assert.doesNotMatch(canvas, /text-destructive|text-muted-foreground/)
  assert.match(canvas, /max-h-\[calc\(100dvh-1rem\)\]/)
  assert.match(canvas, /htmlFor="atlas-canvas-create-title"/)
  assert.match(canvas, /htmlFor="atlas-canvas-create-slug"/)
  assert.match(canvas, /role="alert"/)
  assert.match(canvas, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(canvas, /className="min-h-11 w-full sm:w-auto"/)
  assert.match(canvas, /<AlertDialog[\s\S]*<AlertDialogCancel[\s\S]*<AlertDialogAction/)
  assert.match(eln, /max-h-\[calc\(100dvh-1rem\)\]/)
  assert.match(eln, /grid gap-3 sm:grid-cols-2/)
  for (const presenter of [code, voice]) {
    assert.match(presenter, /h-\[calc\(100dvh-1rem\)\]/)
    assert.match(presenter, /<form className="flex min-h-0 flex-1 flex-col overflow-y-auto"/)
    assert.match(presenter, /atlas-command-presenter__section shrink-0 border-t/)
    assert.match(presenter, /flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end/)
    assert.match(presenter, /className="min-h-11 w-full sm:w-auto" type="submit"/)
  }
  assert.match(code, /AlertDialogAction onClick=\{abandon\} className="atlas-command-presenter__danger-action"/)
  assert.match(voice, /className="atlas-command-presenter__danger-action"/)

  assert.match(focus, /candidate\?\.isConnected/)
  assert.match(focus, /candidate\.matches\(":disabled, \[aria-disabled='true'\], \[inert\], \[inert\] \*"\)/)
  assert.match(focus, /candidate\.focus\(\{ preventScroll: true \}\)/)
  assert.match(focus, /document\.activeElement === candidate/)
  assert.match(styles, /\.atlas-command-presenter \{/)
  assert.match(styles, /\.atlas-command-presenter__surface \{/)
  assert.match(styles, /\.atlas-command-presenter__warning \{ color: hsl\(var\(--field-alert-strong\)\); \}/)
  assert.match(styles, /\.atlas-command-presenter__danger-action \{[\s\S]*color: hsl\(var\(--research-paper\)\);[\s\S]*background: hsl\(var\(--field-alert-strong\)\);/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.atlas-command-presenter \*/)
})

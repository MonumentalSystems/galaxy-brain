"use client"

import type { ComponentProps } from "react"

import { AtlasCanvasCreateDialog } from "@/components/atlas/atlas-canvas-create-dialog"
import { AtlasFrameDialog } from "@/components/atlas/atlas-frame-dialog"
import { CodeGraphSnapshotImportDialog } from "@/components/atlas/code-graph-snapshot-import-dialog"
import { CodeEditorDialog } from "@/components/code/code-editor-dialog"
import { NewExperimentDialog } from "@/components/eln/new-experiment-dialog"
import { TaskConstructorDialog } from "@/components/tasks/task-constructor-dialog"
import { VoiceCaptureDialog } from "@/components/voice/voice-capture-dialog"

export type { CodeEditorPreset, CodeEditorSavePhase } from "@/components/code/code-editor-dialog"
export type {
  CodeGraphSnapshotImportPhase,
  CodeGraphSnapshotImportRequest,
} from "@/components/atlas/code-graph-snapshot-import-dialog"
export type {
  VoiceSavePhase,
  VoiceSaveRequest,
} from "@/components/voice/voice-capture-dialog"

type ElnPresenterProps = Pick<
  ComponentProps<typeof NewExperimentDialog>,
  "open" | "onOpenChange" | "onCreated" | "recoveryScope"
>

type CodePresenterProps = Pick<
  ComponentProps<typeof CodeEditorDialog>,
  | "open"
  | "phase"
  | "error"
  | "notice"
  | "imported"
  | "ambiguous"
  | "scope"
  | "allowWorkspaceFallback"
  | "preset"
  | "onOpenChange"
  | "onSave"
  | "onRetryPlacement"
  | "onAbandon"
  | "onEdit"
>

type CodeGraphPresenterProps = Pick<
  ComponentProps<typeof CodeGraphSnapshotImportDialog>,
  | "open"
  | "phase"
  | "error"
  | "imported"
  | "ambiguous"
  | "onOpenChange"
  | "onImport"
  | "onRetryPlacement"
  | "onKeepWithoutPlacing"
  | "onAbandon"
  | "onEdit"
>

type VoicePresenterProps = Pick<
  ComponentProps<typeof VoiceCaptureDialog>,
  | "open"
  | "phase"
  | "error"
  | "imported"
  | "ambiguous"
  | "recovery"
  | "scope"
  | "allowWorkspaceFallback"
  | "onOpenChange"
  | "onSave"
  | "onRetryPlacement"
  | "onAbandon"
  | "onEdit"
>

type TaskPresenterProps = Pick<
  ComponentProps<typeof TaskConstructorDialog>,
  | "task"
  | "open"
  | "onOpenChange"
  | "returnFocus"
  | "mode"
>

type CanvasPresenterProps = Omit<
  ComponentProps<typeof AtlasCanvasCreateDialog>,
  "returnFocus" | "fallbackFocus"
>
type FramePresenterProps = Omit<ComponentProps<typeof AtlasFrameDialog>, "returnFocus" | "fallbackFocus">

export type AtlasCommandPresenterHostProps = Readonly<{
  returnFocus: HTMLElement | null
  fallbackFocus: HTMLElement | null
  canvas: CanvasPresenterProps | null
  frame: FramePresenterProps
  eln: ElnPresenterProps
  code: CodePresenterProps | null
  codeGraph: CodeGraphPresenterProps | null
  voice: VoicePresenterProps | null
  task: TaskPresenterProps
}>

export function AtlasCommandPresenterHost({
  returnFocus,
  fallbackFocus,
  canvas,
  frame,
  eln,
  code,
  codeGraph,
  voice,
  task,
}: AtlasCommandPresenterHostProps) {
  return (
    <>
      {canvas ? (
        <AtlasCanvasCreateDialog
          key={`${canvas.scope.tenantId}:${canvas.scope.principalId}:${canvas.scope.workspaceId}`}
          {...canvas}
          returnFocus={returnFocus}
          fallbackFocus={fallbackFocus}
        />
      ) : null}
      <AtlasFrameDialog {...frame} returnFocus={returnFocus} fallbackFocus={fallbackFocus} />
      <NewExperimentDialog {...eln} navigateOnCreated={false} returnFocus={returnFocus} fallbackFocus={fallbackFocus} />
      {code ? (
        <CodeEditorDialog
          key={`${code.scope.tenantId}:${code.scope.principalId}:${code.scope.workspaceId}:${code.scope.canvasId}:${code.preset ?? "code"}`}
          {...code}
          returnFocus={returnFocus}
          fallbackFocus={fallbackFocus}
        />
      ) : null}
      {codeGraph ? (
        <CodeGraphSnapshotImportDialog
          {...codeGraph}
          returnFocus={returnFocus}
          fallbackFocus={fallbackFocus}
        />
      ) : null}
      {voice ? <VoiceCaptureDialog {...voice} returnFocus={returnFocus} fallbackFocus={fallbackFocus} /> : null}
      <TaskConstructorDialog {...task} fallbackFocus={fallbackFocus} />
    </>
  )
}

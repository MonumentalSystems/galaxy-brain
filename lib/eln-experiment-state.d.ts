import type { AddMetricInput, Experiment } from "./galaxy-brain-api"
import type { PendingExperimentObservation } from "./eln-experiment-recovery.js"

export function mergeExperimentUpdate(current: Experiment, updated: Experiment | null): Experiment

export function mergeExperimentMetrics(current: Experiment | null, metrics: Experiment["metrics"]): Experiment | null

export function appendExperimentMetric(
  current: Experiment | null,
  metric: AddMetricInput,
  timestamp: string,
): Experiment | null

export function classifyExperimentLoadError(error: unknown): "not-found" | "error"

export function describeExperimentLoadError(error: unknown): string

export function parseConfigSnapshot(input: string): {
  value: Record<string, unknown> | null
  error: string | null
}

export function configSnapshotsEqual(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean

export function rebaseSubmittedExperimentField<T extends string | string[]>(
  submitted: T,
  current: T,
  server: T,
): T

export function experimentSaveCompletionState(
  draftGeneration: number,
  acknowledgedGeneration: number | null,
  outstandingRequests: number,
): "idle" | "saving" | "saved"

export function shouldQueueExperimentSave(outstandingRequests: number): boolean

export function shouldScheduleQueuedExperimentSave(
  queuedGeneration: number | null,
  completedGeneration: number,
): boolean

export function isExperimentSaveRequestActive(
  mounted: boolean,
  requestEpoch: number,
  activeEpoch: number,
  requestExperimentId: string,
  activeExperimentId: string | null,
): boolean

export interface ScopedPendingExperimentObservation {
  scopeKey: string
  operation: PendingExperimentObservation
}

export function pendingExperimentObservationForScope(
  selection: ScopedPendingExperimentObservation | null,
  authorityScopeKey: string,
): PendingExperimentObservation | null

export interface ScopedLoadedExperiment {
  scopeKey: string
  experiment: Experiment
}

export function loadedExperimentForScope(
  selection: ScopedLoadedExperiment | null,
  authorityScopeKey: string,
): Experiment | null

export function observationExperimentForSubmission(
  selection: ScopedLoadedExperiment | null,
  authorityScopeKey: string,
  composerScopeKey: string,
): Experiment | null

export function canonicalizeExperimentTags(input: string | string[]): string[]

export function formatExperimentTags(tags: string[]): string

export function buildExperimentUpdatePatch(
  current: Experiment,
  draft: Pick<
    Experiment,
    | "title"
    | "status"
    | "domain"
    | "hypothesis"
    | "protocol"
    | "config_snapshot"
    | "wandb_run_id"
    | "wandb_project"
    | "local_run_path"
    | "results"
    | "interpretation"
    | "conclusion"
    | "tags"
    | "linked_experiments"
  >,
): import("./galaxy-brain-api").UpdateExperimentInput

export function buildWandbRunUrl(project: string, runId: string): string | null

export function appendEvidenceReference(current: string[], input: string): string[]

export function parseManualMetricDraft(input: {
  name: string
  value: string
  step: string
}): { metric: AddMetricInput | null; error: string | null }

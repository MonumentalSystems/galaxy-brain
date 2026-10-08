import type { CreateExperimentInput } from "./galaxy-brain-api"

export type ElnExperimentRecoveryScope = Readonly<{
  tenantId: string
  principalId: string
}>

export type ElnExperimentRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>

export type PendingExperimentCreate = Readonly<{
  schemaId: "gb.eln-experiment-create-recovery.v1"
  state: "pending-create"
  operationId: string
  input: Readonly<Pick<
    CreateExperimentInput,
    "title" | "hypothesis" | "domain" | "wandb_run_id" | "wandb_project"
  >>
}>

export type PendingExperimentPlacement = Readonly<{
  schemaId: "gb.eln-experiment-placement-recovery.v1"
  state: "pending-placement"
  operationId: string
  experimentId: string
  title: string
  subjectRef: string
  workspaceId: string
  canvasId: string | null
}>

export type PendingExperimentObservation = Readonly<{
  schemaId: "gb.eln-observation-create-recovery.v1"
  state: "pending-observation"
  operationId: string
  experimentId: string
  request: Readonly<{
    schemaId: "gb.eln-observation-create.v1"
    body: string
    observedAt: string | null
  }>
}>

export function elnExperimentRecoveryNamespace(scope: ElnExperimentRecoveryScope): string

export function writePendingExperimentCreate(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  value: Pick<PendingExperimentCreate, "operationId" | "input">,
): PendingExperimentCreate

export function readPendingExperimentCreate(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  operationId: string,
): PendingExperimentCreate | null

export function listPendingExperimentCreates(
  storage: ElnExperimentRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: ElnExperimentRecoveryScope,
): readonly PendingExperimentCreate[]

export function removePendingExperimentCreate(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  operationId: string,
): void

export function writePendingExperimentPlacement(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  value: Pick<
    PendingExperimentPlacement,
    "operationId" | "experimentId" | "title" | "subjectRef" | "workspaceId" | "canvasId"
  >,
): PendingExperimentPlacement

export function readPendingExperimentPlacement(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  operationId: string,
): PendingExperimentPlacement | null

export function listPendingExperimentPlacements(
  storage: ElnExperimentRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: ElnExperimentRecoveryScope,
): readonly PendingExperimentPlacement[]

export function removePendingExperimentPlacement(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  operationId: string,
): void

export function writePendingExperimentObservation(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  value: Pick<PendingExperimentObservation, "operationId" | "experimentId" | "request">,
): PendingExperimentObservation

export function listPendingExperimentObservations(
  storage: ElnExperimentRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: ElnExperimentRecoveryScope,
  experimentId: string,
): readonly PendingExperimentObservation[]

export function removePendingExperimentObservation(
  storage: ElnExperimentRecoveryStorage,
  scope: ElnExperimentRecoveryScope,
  experimentId: string,
  operationId: string,
): void

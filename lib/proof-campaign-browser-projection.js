const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const DISPATCH_STATES = new Set(["authorized", "dispatched", "outcome_unknown", "partial"])
const TASK_STATES = new Set(["authorized", "dispatched", "failed", "outcome_unknown", "reused"])

function invalid(label) {
  throw new Error(`Hyades returned an invalid ${label}`)
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label)
  return value
}

function requiredString(value, label, maxLength = 500) {
  if (typeof value !== "string" || !value || value.length > maxLength) invalid(label)
  return value
}

function optionalString(value, label, maxLength = 500) {
  if (value == null) return undefined
  return requiredString(value, label, maxLength)
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") invalid(label)
  return value
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) invalid(label)
  return value
}

function programId(value) {
  if (typeof value !== "string" || !PROGRAM_ID_PATTERN.test(value)) invalid("program ID")
  return value
}

function stringArray(value, label, maxItems = 2_048) {
  if (!Array.isArray(value) || value.length > maxItems) invalid(label)
  return value.map((item) => requiredString(item, label, 300))
}

function projectTarget(value) {
  const target = objectValue(value, "campaign target")
  return {
    packetId: requiredString(target.packetId ?? target.packet_id, "target packet ID", 120),
    action: requiredString(target.action, "target action", 120),
  }
}

function projectDirective(value) {
  const directive = objectValue(value, "campaign directive")
  const targets = directive.targets == null
    ? undefined
    : (Array.isArray(directive.targets) ? directive.targets.map(projectTarget) : invalid("campaign targets"))
  return {
    decision: optionalString(directive.decision, "campaign decision", 80),
    ...(targets ? { targets } : {}),
  }
}

function projectRegistrationReceipt(value) {
  const receipt = objectValue(value, "registration receipt")
  return {
    programId: programId(receipt.programId),
    programSha256: sha256(receipt.programSha256, "registration program hash"),
    progressSha256: sha256(receipt.progressSha256, "registration progress hash"),
    directiveSha256: sha256(receipt.directiveSha256, "registration directive hash"),
    registeredAt: requiredString(receipt.registeredAt, "registration timestamp", 100),
    readyPacketIds: stringArray(receipt.readyPacketIds, "ready packet IDs"),
    immutable: booleanValue(receipt.immutable, "registration immutability state"),
    authorityGranted: booleanValue(receipt.authorityGranted, "registration authority state"),
    sideEffectsAuthorized: booleanValue(receipt.sideEffectsAuthorized, "registration side-effect state"),
  }
}

function projectDispatchTask(value) {
  const task = objectValue(value, "dispatch task")
  const state = requiredString(task.state, "dispatch task state", 40)
  if (!TASK_STATES.has(state)) invalid("dispatch task state")
  const taskId = optionalString(task.taskId, "HAM task ID", 300)
  return {
    packetId: requiredString(task.packetId, "dispatch packet ID", 120),
    state,
    ...(taskId ? { taskId } : {}),
  }
}

function projectDispatchReceipt(value) {
  const receipt = objectValue(value, "dispatch receipt")
  const state = requiredString(receipt.state, "dispatch state", 40)
  if (!DISPATCH_STATES.has(state)) invalid("dispatch state")
  if (!Array.isArray(receipt.tasks) || receipt.tasks.length > 2_048) invalid("dispatch tasks")
  return {
    dispatchId: requiredString(receipt.dispatchId, "dispatch ID", 300),
    directiveSha256: sha256(receipt.directiveSha256, "dispatch directive hash"),
    state,
    tasks: receipt.tasks.map(projectDispatchTask),
  }
}

function projectPreview(value) {
  const preview = objectValue(value, "campaign preview")
  if (preview.authorityGranted !== false || preview.sideEffectsAuthorized !== false) {
    invalid("non-authoritative campaign preview")
  }
  return {
    programId: programId(preview.programId),
    programSha256: sha256(preview.programSha256, "preview program hash"),
    progressSha256: sha256(preview.progressSha256, "preview progress hash"),
    directiveSha256: sha256(preview.directiveSha256, "preview directive hash"),
    readyPacketIds: stringArray(preview.readyPacketIds, "preview ready packet IDs"),
    authorityGranted: false,
    sideEffectsAuthorized: false,
    directive: projectDirective(preview.directive),
  }
}

function projectController(value) {
  const controller = objectValue(value, "campaign controller")
  const currentDirectiveSha256 = controller.currentDirectiveSha256 == null
    ? undefined
    : sha256(controller.currentDirectiveSha256, "current directive hash")
  const allDispatches = controller.dispatches == null ? [] : controller.dispatches
  if (!Array.isArray(allDispatches) || allDispatches.length > 2_048) invalid("controller dispatches")
  const currentDispatches = currentDirectiveSha256
    ? allDispatches.filter((receipt) => receipt?.directiveSha256 === currentDirectiveSha256)
    : []
  const latestDispatch = currentDispatches[currentDispatches.length - 1]
  return {
    programId: programId(controller.programId),
    currentDirectiveSha256,
    currentDecision: optionalString(controller.currentDecision, "current decision", 80),
    currentTargets: controller.currentTargets == null
      ? []
      : (Array.isArray(controller.currentTargets) ? controller.currentTargets.map(projectTarget) : invalid("current targets")),
    dispatches: latestDispatch ? [projectDispatchReceipt(latestDispatch)] : [],
    registration: controller.registration == null ? null : projectRegistrationReceipt(controller.registration),
  }
}

export function projectProofCampaignResponseForBrowser(operation, value) {
  const response = objectValue(value, "proof campaign response")
  if (operation === "preview") return { preview: projectPreview(response.preview) }
  if (operation === "register") return { receipt: projectRegistrationReceipt(response.receipt) }
  if (operation === "dispatch") return { receipt: projectDispatchReceipt(response.receipt) }
  if (operation === "status") return projectController(response)
  if (operation === "registration") {
    return {
      programId: programId(response.programId),
      registration: projectRegistrationReceipt(response.registration),
      directive: projectDirective(response.directive),
    }
  }
  invalid("proof campaign operation")
}

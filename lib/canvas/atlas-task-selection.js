import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"

function canonicalTaskReference(value) {
  const reference = parseGalaxyObjectReference(value)
  if (reference?.format !== "canonical" || reference.kind !== "ham.task") return null
  try {
    return serializeGalaxyObjectReference(reference) === value ? reference : null
  } catch {
    return null
  }
}

function exactTaskSnapshot(tasks, taskId) {
  if (!Array.isArray(tasks)) return null
  const matches = tasks.filter((task) => (
    task
    && typeof task === "object"
    && !Array.isArray(task)
    && task.id === taskId
    && task.projectionSource === "ham"
    && Number.isSafeInteger(task.version)
    && task.version > 0
  ))
  return matches.length === 1 ? matches[0] : null
}

function hydrationMatchesTask(hydration, subjectRef, task, expectedRevision) {
  if (hydration === undefined) return true
  if (
    !hydration
    || typeof hydration !== "object"
    || Array.isArray(hydration)
    || hydration.status !== "resolved"
    || hydration.requestedRef !== subjectRef
    || hydration.resolvedRef !== subjectRef
    || hydration.provider !== "ham"
  ) return false

  const projection = hydration.projection
  return Boolean(
    projection
    && typeof projection === "object"
    && !Array.isArray(projection)
    && projection.schemaId === "gb.object-projection.v1"
    && projection.ref === subjectRef
    && projection.kind === "ham.task"
    && projection.provenance?.provider === "ham"
    && projection.provenance?.sourceId === task.id
    && projection.provenance?.sourceRevision === expectedRevision
  )
}

/**
 * Resolve an Atlas task placement into the exact, version-pinned command input.
 * The placement itself may follow the HAM task head; opening the constructor
 * must remain bound to the authorized snapshot the user actually inspected.
 */
export function resolveAtlasTaskSelection({
  subjectRef,
  availability,
  hydration,
  tasks,
} = {}) {
  const reference = canonicalTaskReference(subjectRef)
  if (!reference) return null
  if (hydration === undefined && availability !== "resolved") return null

  const task = exactTaskSnapshot(tasks, reference.id)
  if (!task) return null
  const expectedRevision = `version:${task.version}`
  if (reference.selector.mode === "pinned" && reference.selector.revision !== expectedRevision) {
    return null
  }
  if (!hydrationMatchesTask(hydration, subjectRef, task, expectedRevision)) return null

  const commandSubjectRef = createGalaxyObjectReference("ham.task", task.id, {
    mode: "pinned",
    revision: expectedRevision,
  })
  return Object.freeze({ task, subjectRef: commandSubjectRef })
}

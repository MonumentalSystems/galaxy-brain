import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const PAPER_ENHANCE_INTENTS = Object.freeze(["explain", "challenge", "compare", "synthesize"])
export const MAX_PAPER_ENHANCE_REFERENCES = 8
export const MAX_PAPER_ENHANCE_REFERENCE_CHARACTERS = 500

const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/u

function invalid(message) {
  throw new TypeError(`Invalid paper enhancement: ${message}`)
}

function canonicalPinnedReference(value, label) {
  if (typeof value !== "string" || Array.from(value).length < 1
    || Array.from(value).length > MAX_PAPER_ENHANCE_REFERENCE_CHARACTERS) {
    invalid(`${label} must contain at most ${MAX_PAPER_ENHANCE_REFERENCE_CHARACTERS} characters`)
  }
  const parsed = parseGalaxyObjectReference(value)
  let wire = ""
  try {
    wire = parsed ? serializeGalaxyObjectReference(parsed) : ""
  } catch {
    wire = ""
  }
  if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned" || wire !== value) {
    invalid(`${label} must be a canonical pinned Galaxy reference`)
  }
  return wire
}

export function normalizePaperEnhanceReferences(anchorRef, additionalRefs = []) {
  const anchor = canonicalPinnedReference(anchorRef, "anchorRef")
  const parsedAnchor = parseGalaxyObjectReference(anchor)
  if (parsedAnchor?.kind !== "document.anchor") {
    invalid("anchorRef must identify an exact document anchor")
  }
  const values = typeof additionalRefs === "string"
    ? additionalRefs.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    : additionalRefs
  if (!Array.isArray(values)) invalid("additionalRefs must be a list or one reference per line")
  const result = [anchor]
  for (const [index, value] of values.entries()) {
    const reference = canonicalPinnedReference(value, `additionalRefs[${index}]`)
    if (!result.includes(reference)) result.push(reference)
    if (result.length > MAX_PAPER_ENHANCE_REFERENCES) {
      invalid(`at most ${MAX_PAPER_ENHANCE_REFERENCES} distinct references may be used`)
    }
  }
  return Object.freeze(result)
}

export function paperEnhanceReferenceInputState(anchorRef, additionalRefs = "") {
  try {
    return Object.freeze({
      references: normalizePaperEnhanceReferences(anchorRef, additionalRefs),
      error: "",
    })
  } catch (error) {
    return Object.freeze({
      references: Object.freeze([]),
      error: error instanceof Error ? error.message : "The reference list is invalid.",
    })
  }
}

export function paperEnhancePreset(intent, paperTitle) {
  if (!PAPER_ENHANCE_INTENTS.includes(intent)) invalid("intent is unsupported")
  const title = typeof paperTitle === "string" ? paperTitle.trim() : ""
  if (!title) invalid("paperTitle is required")
  const boundedTitle = Array.from(title).slice(0, 150).join("")
  const copy = {
    explain: {
      title: `Explain: ${boundedTitle}`,
      goal: "Explain the exact anchored passage in context, preserving its claims, assumptions, notation, and source boundary.",
    },
    challenge: {
      title: `Challenge: ${boundedTitle}`,
      goal: "Challenge the exact anchored passage by testing its assumptions, searching for counterevidence, and preserving traceable citations.",
    },
    compare: {
      title: `Compare: ${boundedTitle}`,
      goal: "Compare the explicitly selected pinned sources against shared criteria, preserving disagreements and source-specific provenance.",
    },
    synthesize: {
      title: `Synthesize: ${boundedTitle}`,
      goal: "Synthesize the explicitly selected pinned sources into a cited account of compatible findings, tensions, and useful fusions.",
    },
  }[intent]
  return Object.freeze({
    intent,
    title: Array.from(copy.title).slice(0, 200).join(""),
    goal: copy.goal,
  })
}

export function paperEnhanceIntentAvailability(intent, references, readable) {
  if (!PAPER_ENHANCE_INTENTS.includes(intent)) invalid("intent is unsupported")
  if (!Array.isArray(references) || references.length < 1 || references.length > MAX_PAPER_ENHANCE_REFERENCES) {
    invalid("references are outside the supported bounds")
  }
  if (intent === "explain" || intent === "challenge") {
    return Object.freeze({ enabled: references.length === 1, reason: references.length === 1
      ? "Ready from the selected exact anchor."
      : "Explain and Challenge use only the selected exact anchor." })
  }
  if (references.length < 2) {
    return Object.freeze({ enabled: false, reason: "Add at least one other canonical pinned reference." })
  }
  if (readable !== true) {
    return Object.freeze({ enabled: false, reason: "Check that all selected references are readable before continuing." })
  }
  return Object.freeze({ enabled: true, reason: `${references.length} readable pinned references selected.` })
}

export function paperEnhanceIntentAvailabilityForInput(intent, input, readable) {
  if (!PAPER_ENHANCE_INTENTS.includes(intent)) invalid("intent is unsupported")
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.references) || typeof input.error !== "string") {
    invalid("reference input state is invalid")
  }
  if (input.error || input.references.length < 1 || input.references.length > MAX_PAPER_ENHANCE_REFERENCES) {
    return Object.freeze({
      enabled: false,
      reason: input.error || (input.references.length < 1
        ? "Select one saved exact anchor first."
        : `At most ${MAX_PAPER_ENHANCE_REFERENCES} distinct references may be used.`),
    })
  }
  return paperEnhanceIntentAvailability(intent, input.references, readable)
}

export function paperTaskConstructorHref(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)
    || typeof task.id !== "string" || !TASK_ID.test(task.id)
    || !Number.isSafeInteger(task.version) || task.version < 1) {
    invalid("task must have an exact safe identifier and positive version")
  }
  return `/tasks?${new URLSearchParams({ construct: task.id, version: String(task.version) })}`
}

function canonicalTaskReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  let wire = ""
  try {
    wire = parsed ? serializeGalaxyObjectReference(parsed) : ""
  } catch {
    wire = ""
  }
  return parsed?.format === "canonical" && parsed.kind === "ham.task" && wire === value
    ? parsed
    : null
}

export function paperTaskConstructorHrefFromLink(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const taskEndpoints = [value.from_ref, value.to_ref]
    .map(canonicalTaskReference)
    .filter(Boolean)
  if (taskEndpoints.length !== 1) return undefined
  const evidence = canonicalTaskReference(value.provenance?.source_ref)
  if (!evidence || evidence.id !== taskEndpoints[0].id || evidence.selector.mode !== "pinned") return undefined
  const match = /^version:([1-9][0-9]{0,14})$/u.exec(evidence.selector.revision)
  if (!match) return undefined
  const version = Number(match[1])
  if (!Number.isSafeInteger(version)) return undefined
  try {
    return paperTaskConstructorHref({ id: evidence.id, version })
  } catch {
    return undefined
  }
}

export function parsePaperTaskConstructorRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const taskId = value.construct
  const versionText = value.version
  if (taskId === undefined && versionText === undefined) return null
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)
    || typeof versionText !== "string" || !/^[1-9][0-9]{0,14}$/u.test(versionText)) {
    invalid("constructor deep link is invalid")
  }
  const version = Number(versionText)
  if (!Number.isSafeInteger(version) || version < 1) invalid("constructor deep link is invalid")
  return Object.freeze({ taskId, version })
}

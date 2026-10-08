function contextId(value) {
  if (typeof value !== "string" || !value || value.length > 1024) {
    throw new TypeError("Task plan draft context must be a stable non-empty string")
  }
  return value
}

function token(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.context !== "string"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
  ) {
    throw new TypeError("Task plan draft token is invalid")
  }
  return value
}

export function createTaskPlanDraftGuard(initialContext) {
  let context = contextId(initialContext)
  let generation = 0

  const capture = () => Object.freeze({ context, generation })

  return Object.freeze({
    enter(nextContext) {
      const next = contextId(nextContext)
      if (next !== context) {
        context = next
        generation += 1
      }
      return capture()
    },
    edit(expectedContext) {
      if (contextId(expectedContext) !== context) {
        throw new TypeError("Task plan draft context changed before the edit")
      }
      generation += 1
      return capture()
    },
    capture(expectedContext) {
      if (contextId(expectedContext) !== context) {
        throw new TypeError("Task plan draft context changed before capture")
      }
      return capture()
    },
    isCurrent(candidate) {
      const observed = token(candidate)
      return observed.context === context && observed.generation === generation
    },
    isContextCurrent(candidate) {
      return token(candidate).context === context
    },
  })
}

export function createTaskPlanLatestRequestGuard() {
  let generation = 0
  return Object.freeze({
    begin() {
      generation += 1
      return generation
    },
    isLatest(candidate) {
      return Number.isSafeInteger(candidate) && candidate > 0 && candidate === generation
    },
  })
}

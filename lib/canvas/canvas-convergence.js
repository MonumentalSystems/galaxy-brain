import {
  CANVAS_CHANGE_POLL_INTERVAL_MS,
  CANVAS_CHANGE_POLL_MAX_INTERVAL_MS,
  canvasChangePollDelay,
} from "./canvas-snapshot.js"

export const CANVAS_CHANGE_POLL_TIMEOUT_MS = 10_000

const TERMINAL_STATUSES = new Set([401, 403, 404])

export function isTerminalCanvasPollError(error) {
  return Boolean(
    error
    && typeof error === "object"
    && TERMINAL_STATUSES.has(error.status),
  )
}

export function createCanvasChangePoller({
  request,
  onEvent,
  onTerminalError,
  initialDelayMs = CANVAS_CHANGE_POLL_INTERVAL_MS,
  timeoutMs = CANVAS_CHANGE_POLL_TIMEOUT_MS,
}) {
  let active = false
  let visible = true
  let inFlight = false
  let resumeWhenIdle = false
  let consecutiveFailures = 0
  let generation = 0
  let timer = null
  let controller = null

  const clearScheduled = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }
  const schedule = (delay) => {
    if (!active) return
    clearScheduled()
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, delay)
  }
  const stop = () => {
    active = false
    generation += 1
    resumeWhenIdle = false
    clearScheduled()
    controller?.abort()
  }

  async function poll() {
    if (!active) return
    if (!visible) {
      schedule(CANVAS_CHANGE_POLL_MAX_INTERVAL_MS)
      return
    }
    if (inFlight) {
      resumeWhenIdle = true
      return
    }

    inFlight = true
    resumeWhenIdle = false
    const pollGeneration = ++generation
    const pollController = new AbortController()
    controller = pollController
    const timeout = setTimeout(() => pollController.abort(), timeoutMs)
    let stopAfterPoll = false
    let nextDelay = CANVAS_CHANGE_POLL_INTERVAL_MS

    try {
      const event = await request(pollController.signal)
      if (!active || pollGeneration !== generation) return
      consecutiveFailures = 0
      stopAfterPoll = onEvent(event) === "stop"
    } catch (error) {
      if (!active || pollGeneration !== generation) return
      if (isTerminalCanvasPollError(error)) {
        onTerminalError(error)
        stopAfterPoll = true
      } else {
        consecutiveFailures += 1
        nextDelay = canvasChangePollDelay(consecutiveFailures)
      }
    } finally {
      clearTimeout(timeout)
      if (controller === pollController) controller = null
      inFlight = false
      if (!active) return
      if (stopAfterPoll) {
        stop()
        return
      }
      if (pollGeneration !== generation) {
        if (resumeWhenIdle && visible) {
          resumeWhenIdle = false
          schedule(0)
        } else if (timer === null) {
          schedule(visible ? CANVAS_CHANGE_POLL_INTERVAL_MS : CANVAS_CHANGE_POLL_MAX_INTERVAL_MS)
        }
        return
      }
      schedule(nextDelay)
    }
  }

  return {
    start() {
      if (active) return
      active = true
      visible = true
      schedule(initialDelayMs)
    },
    setVisible(nextVisible) {
      if (!active || visible === nextVisible) return
      visible = nextVisible
      if (nextVisible) consecutiveFailures = 0
      generation += 1
      clearScheduled()
      resumeWhenIdle = nextVisible
      controller?.abort()
      if (!inFlight) {
        resumeWhenIdle = false
        schedule(nextVisible ? 0 : CANVAS_CHANGE_POLL_MAX_INTERVAL_MS)
      } else if (!nextVisible) {
        schedule(CANVAS_CHANGE_POLL_MAX_INTERVAL_MS)
      }
    },
    stop,
  }
}

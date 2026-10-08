/**
 * The Galaxy Brain BFF exposes human task creation/read projections plus one
 * requester-scoped reconciliation action. Claiming, starting runs, reporting
 * progress, and ordinary agent responses remain agent-authenticated HAM MCP
 * operations.
 */
export const HAM_TASK_PROXY_OPERATIONS = Object.freeze({
  create: { method: "POST" },
  page: { method: "POST" },
  detail: { method: "GET" },
  events: { method: "POST" },
  externalComplete: { method: "POST" },
})

function segment(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return encodeURIComponent(value.trim())
}
export function getHamTaskProxyRoute(operation, refs = {}) {
  if (!(operation in HAM_TASK_PROXY_OPERATIONS)) {
    throw new Error(`HAM task proxy operation is not allowed: ${operation}`)
  }

  if (operation === "create") {
    return {
      method: "POST",
      path: `/projects/${segment(refs.projectRef, "projectRef")}/tasks`,
    }
  }
  if (operation === "page") {
    return { method: "POST", path: "/tasks/page" }
  }
  if (operation === "detail") {
    return {
      method: "GET",
      path: `/tasks/${segment(refs.taskId, "taskId")}`,
    }
  }
  if (operation === "externalComplete") {
    return {
      method: "POST",
      path: `/tasks/${segment(refs.taskId, "taskId")}/respond`,
    }
  }
  return { method: "POST", path: "/task-events/page" }
}

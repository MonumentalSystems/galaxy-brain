/** Reject decoded separators and escapes before authorization or URL construction. */
export function isSafeElnPath(path) {
  return Array.isArray(path) && path.length > 0 && path.every((segment) =>
    typeof segment === "string" && segment.length > 0
    && segment !== "." && segment !== ".."
    && !/[\\/%?#\u0000-\u001f\u007f]/.test(segment),
  )
}

/**
 * Classify public ELN proxy operations. Request identities currently receive
 * tenant-wide authority; these names remain only as route metadata.
 */
export function requiredElnScopes(method, path, transitionType = "") {
  const read = method === "GET" || method === "HEAD"
  if (path[0] === "documents" || path[0] === "document-anchors") {
    const primary = read ? "document:read" : "document:write"
    return { primary, accepted: [primary, read ? "eln:read" : "eln:write"] }
  }
  if (path[0] === "canvases") {
    const primary = read ? "canvas:read" : "canvas:write"
    return { primary, accepted: [primary] }
  }
  if (path[0] === "conversations") {
    const primary = read ? "conversation:read" : "conversation:write"
    return { primary, accepted: [primary] }
  }
  if (path[0] === "object-references") {
    const primary = "object-link:read"
    return { primary, accepted: [primary, "eln:read"] }
  }
  if (path[0] === "object-links") {
    const primary = read ? "object-link:read" : "object-link:write"
    return { primary, accepted: [primary, read ? "eln:read" : "eln:write"] }
  }
  if (path[0] === "proof-workspaces") {
    let primary = "proof-work:admin"
    if (read) primary = "proof-work:read"
    else if (path.length === 5 && path[2] === "nodes" && path[4] === "verify") {
      primary = "proof-work:verify"
    }
    else if (path.length === 3 && path[2] === "transitions") {
      if (["claim.acquire", "claim.release"].includes(transitionType)) primary = "proof-work:claim"
      else if (["work.set", "proof.candidate", "proof.attest"].includes(transitionType)) primary = "proof-work:execute"
      else if (["proof.verify", "proof.reject"].includes(transitionType)) primary = "proof-work:invalid-transition"
      else if (transitionType === "proof.supersede") primary = "proof-work:admin"
      else if (transitionType === "proof.override") primary = "proof-work:override"
      else if (transitionType === "external.set") primary = "proof-work:external"
      else primary = "proof-work:invalid-transition"
    }
    return { primary, accepted: [primary] }
  }
  if (path[0] === "proof-graphs") {
    if (method === "POST" && path.length === 3 && path[2] === "mission-activations") {
      return { primary: "proof-work:admin", accepted: ["proof-work:admin"] }
    }
    if (method === "POST" && path.length === 3 && path[2] === "mission-candidates") {
      return { primary: "proof-graph:read", accepted: ["proof-graph:read"] }
    }
    const primary = read ? "proof-graph:read" : "proof-graph:write"
    return { primary, accepted: [primary] }
  }
  if (path[0] === "formal-project-packages") {
    const primary = read ? "proof-graph:read" : "proof-graph:write"
    return { primary, accepted: [primary] }
  }
  if (path[0] === "proof-verification-sets") {
    const primary = read ? "proof-verification:read" : "proof-verification:write"
    return { primary, accepted: [primary] }
  }
  if (path[0] === "task-plans") {
    const primary = read ? "task-plan:read" : "task-plan:write"
    return { primary, accepted: [primary, read ? "eln:read" : "eln:write"] }
  }
  if (path[0] !== "surfaces") {
    const primary = read ? "eln:read" : "eln:write"
    return { primary, accepted: [primary] }
  }

  if (read) {
    return { primary: "surface:read", accepted: ["surface:read", "eln:read"] }
  }
  if (method === "POST" && path.length === 3 && path[2] === "promote") {
    return {
      primary: "surface:promote",
      accepted: ["surface:promote", "eln:write"],
    }
  }
  return { primary: "surface:write", accepted: ["surface:write", "eln:write"] }
}

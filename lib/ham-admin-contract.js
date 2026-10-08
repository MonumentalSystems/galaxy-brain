const IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/
const NOSTR_PUBKEY_PATTERN = /^[a-f0-9]{64}$/
const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export const HAM_ADMIN_PAGE_SIZE = 500
export const HAM_ADMIN_MAX_PAGES = 200

export const HAM_ADMIN_MUTATIONS = Object.freeze([
  "createProject",
  "registerCurrentPrincipal",
  "registerAgentPrincipal",
  "createMember",
  "revokePrincipal",
  "revokeMember",
  "createCredential",
  "revokeCredential",
])

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}$/

function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.")
  }
  return value
}

function text(value, label, maxLength, { optional = false } = {}) {
  if (value == null && optional) return null
  if (typeof value !== "string") throw new Error(`${label} must be text.`)
  const cleaned = value.trim()
  if (!cleaned && optional) return null
  if (!cleaned) throw new Error(`${label} is required.`)
  if (cleaned.length > maxLength) throw new Error(`${label} is too long.`)
  return cleaned
}

function id(value, label) {
  const cleaned = text(value, label, 32).toLowerCase()
  if (!IDENTIFIER_PATTERN.test(cleaned)) throw new Error(`${label} is invalid.`)
  return cleaned
}

function pubkey(value, label = "Nostr public key") {
  const cleaned = text(value, label, 64).toLowerCase()
  if (!NOSTR_PUBKEY_PATTERN.test(cleaned)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters.`)
  }
  return cleaned
}

function wholeNumber(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return value
}

function expiresAt(nowMs, amount, unitMs) {
  return new Date(nowMs + amount * unitMs).toISOString()
}

export function getHamAdminReadRoutes(projectIds = [], offset = 0, limit = HAM_ADMIN_PAGE_SIZE) {
  wholeNumber(offset, "Page offset", 0, 100_000)
  wholeNumber(limit, "Page limit", 1, HAM_ADMIN_PAGE_SIZE)
  const routes = [
    { key: "identity", path: "/whoami" },
    { key: "projects", path: `/projects?limit=${limit}&offset=${offset}` },
    { key: "principals", path: `/admin/nostr-principals?limit=${limit}&offset=${offset}` },
    { key: "credentials", path: "/admin/credentials" },
  ]
  for (const projectId of projectIds) {
    const cleanId = id(projectId, "Project ID")
    routes.push({ key: `members:${cleanId}`, path: `/admin/projects/${cleanId}/members?limit=${limit}&offset=${offset}` })
  }
  return routes
}

export async function collectHamAdminPages(
  fetchPage,
  idField,
  { pageSize = HAM_ADMIN_PAGE_SIZE, maxPages = HAM_ADMIN_MAX_PAGES } = {},
) {
  const rows = []
  const seen = new Set()
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(pageNumber * pageSize, pageSize)
    if (!Array.isArray(page)) throw new Error("HAM inventory page is not a list.")
    for (const row of page) {
      const rowId = row && typeof row === "object" ? row[idField] : null
      if (typeof rowId !== "string" || !rowId) throw new Error("HAM inventory row is missing its identifier.")
      if (seen.has(rowId)) throw new Error("HAM inventory pagination did not advance.")
      seen.add(rowId)
      rows.push(row)
    }
    if (page.length < pageSize) return rows
  }
  throw new Error("HAM inventory exceeds the bounded pagination limit.")
}

export function isPrincipalExpired(expiresAtValue, nowMs = Date.now()) {
  if (!expiresAtValue) return false
  const expiryMs = Date.parse(expiresAtValue)
  return !Number.isFinite(expiryMs) || expiryMs <= nowMs
}

export function parseHamAdminMutation(input, nowMs = Date.now(), trusted = {}) {
  const source = objectValue(input)
  const action = text(source.action, "Action", 80)
  if (!HAM_ADMIN_MUTATIONS.includes(action)) throw new Error("Admin action is not allowed.")

  if (action === "createProject") {
    const name = text(source.name, "Project name", 200)
    const slug = text(source.slug, "Project slug", 120).toLowerCase()
    if (!PROJECT_SLUG_PATTERN.test(slug)) {
      throw new Error("Project slug must start with a letter or number and use lowercase letters, numbers, dot, underscore, or hyphen.")
    }
    const repo = text(source.repo, "Repository", 300, { optional: true })
    if (repo && !REPOSITORY_PATTERN.test(repo)) throw new Error("Repository must use owner/name format.")
    return {
      action,
      method: "POST",
      path: "/admin/projects",
      body: {
        name,
        slug,
        repo,
        description: text(source.description, "Description", 2_000, { optional: true }),
      },
    }
  }

  if (action === "registerCurrentPrincipal") {
    const currentPubkey = pubkey(trusted.currentNostrPubkey, "Signed-in Nostr public key")
    return {
      action,
      method: "POST",
      path: "/admin/nostr-principals",
      body: {
        pubkey: currentPubkey,
        label: "Galaxy Brain owner",
      },
    }
  }

  if (action === "registerAgentPrincipal") {
    const durationDays = wholeNumber(source.durationDays, "Principal duration", 1, 3650)
    return {
      action,
      method: "POST",
      path: "/admin/nostr-principals",
      body: {
        pubkey: pubkey(source.pubkey),
        label: text(source.label, "Label", 200, { optional: true }),
        expires_at: expiresAt(nowMs, durationDays, 24 * 60 * 60 * 1_000),
      },
    }
  }

  if (action === "createMember") {
    const projectId = id(source.projectId, "Project ID")
    return {
      action,
      method: "POST",
      path: `/admin/projects/${projectId}/members`,
      body: { pubkey: pubkey(source.pubkey) },
    }
  }

  if (action === "createCredential") {
    const agentId = text(source.agentId, "Agent ID", 120)
    if (!AGENT_ID_PATTERN.test(agentId)) {
      throw new Error("Agent ID must start with a letter or number and use lowercase letters, numbers, dot, underscore, or hyphen.")
    }
    return {
      action,
      method: "POST",
      path: "/admin/credentials",
      body: {
        agent_id: agentId,
        actor_type: "service",
      },
    }
  }

  if (action === "revokeCredential") {
    const credentialId = id(source.credentialId, "Credential ID")
    return {
      action,
      method: "DELETE",
      path: `/admin/credentials/${credentialId}`,
      body: null,
    }
  }

  if (action === "revokePrincipal") {
    const principalPubkey = pubkey(source.pubkey)
    return {
      action,
      method: "DELETE",
      path: `/admin/nostr-principals/${principalPubkey}`,
      body: null,
    }
  }

  const projectId = id(source.projectId, "Project ID")
  const membershipId = id(source.membershipId, "Membership ID")
  return {
    action,
    method: "DELETE",
    path: `/admin/projects/${projectId}/members/${membershipId}`,
    body: null,
  }
}

export function isFreshAuthentication(authenticatedAt, nowMs = Date.now(), maxAgeMinutes = 15) {
  const authenticatedMs = Date.parse(authenticatedAt)
  if (!Number.isFinite(authenticatedMs)) return false
  const maxAgeMs = Math.max(1, Math.min(maxAgeMinutes, 60)) * 60 * 1_000
  return authenticatedMs <= nowMs && nowMs - authenticatedMs <= maxAgeMs
}

import { chmod, writeFile } from "node:fs/promises"
import process from "node:process"

const destination = process.env.PGSERVICEFILE?.trim()
if (!destination) throw new Error("PGSERVICEFILE is required")
const passwordDestination = process.env.PGPASSFILE?.trim()
if (!passwordDestination) throw new Error("PGPASSFILE is required")

const supportedParameters = new Set([
  "application_name",
  "channel_binding",
  "connect_timeout",
  "sslmode",
])

function safeServiceValue(value, label) {
  if (!/^[A-Za-z0-9_.:/-]+$/.test(value)) {
    throw new Error(`${label} contains characters unsupported by the credential-safe service writer`)
  }
  return value
}

function pgpassValue(value) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("decoded PostgreSQL credentials may not contain line breaks")
  }
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:")
}

function service(name, environmentName) {
  const raw = process.env[environmentName]?.trim()
  if (!raw || raw.includes("\n")) throw new Error(`${environmentName} must be a single-line URL`)
  const url = new URL(raw)
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${environmentName} must use postgres:// or postgresql://`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!url.hostname || !database || !url.username) {
    throw new Error(`${environmentName} must include host, database, and user`)
  }
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const values = {
    host: safeServiceValue(url.hostname, `${environmentName} host`),
    port: safeServiceValue(url.port || "5432", `${environmentName} port`),
    dbname: safeServiceValue(database, `${environmentName} database`),
    user: safeServiceValue(user, `${environmentName} user`),
  }
  for (const [key, value] of url.searchParams) {
    if (!supportedParameters.has(key)) {
      throw new Error(`${environmentName} uses unsupported connection parameter ${key}`)
    }
    values[key] = safeServiceValue(value, `${environmentName} ${key}`)
  }
  return {
    service: [`[${name}]`, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("\n"),
    password: [url.hostname, url.port || "5432", database, user, password]
      .map(pgpassValue)
      .join(":"),
  }
}

const serviceDefinitions = [
  ["neon_source", "NEON_SOURCE_DATABASE_URL"],
  ["api_source", "GALAXY_API_SOURCE_DATABASE_URL"],
  ["target", "GALAXY_TARGET_DATABASE_URL"],
]
const services = serviceDefinitions
  .filter(([, environmentName]) => process.env[environmentName]?.trim())
  .map(([name, environmentName]) => service(name, environmentName))
if (services.length === 0) throw new Error("at least one PostgreSQL URL is required")
const contents = [...services.map(({ service: value }) => value), ""].join("\n")
const passwords = [...new Set(services.map(({ password }) => password)), ""].join("\n")

await writeFile(destination, contents, { mode: 0o600 })
await chmod(destination, 0o600)
await writeFile(passwordDestination, passwords, { mode: 0o600 })
await chmod(passwordDestination, 0o600)

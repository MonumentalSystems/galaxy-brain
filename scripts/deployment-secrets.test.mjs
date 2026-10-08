import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const projections = new Map([
  ["POSTGRES_PASSWORD", "GALAXY_DEPLOY_POSTGRES_PASSWORD"],
  ["DATABASE_MIGRATION_URL", "GALAXY_DEPLOY_DATABASE_MIGRATION_URL"],
  ["DATABASE_URL", "GALAXY_DEPLOY_DATABASE_URL"],
  ["GB_DATABASE_URL", "GALAXY_DEPLOY_GB_DATABASE_URL"],
  ["REGISTRATION_INVITE_CODE", "GALAXY_DEPLOY_REGISTRATION_INVITE_CODE"],
  ["GALAXY_API_PROXY_TOKEN", "GALAXY_DEPLOY_GALAXY_API_PROXY_TOKEN"],
  ["DOCLING_API_KEY", "GALAXY_DEPLOY_DOCLING_API_KEY"],
  ["MARKITDOWN_PROXY_TOKEN", "GALAXY_DEPLOY_MARKITDOWN_PROXY_TOKEN"],
  ["SMTP_URL", "GALAXY_DEPLOY_SMTP_URL"],
  ["HAM_API_BEARER_TOKEN", "GALAXY_DEPLOY_HAM_API_BEARER_TOKEN"],
  ["HAM_TASK_READ_BEARER_TOKEN", "GALAXY_DEPLOY_HAM_TASK_READ_BEARER_TOKEN"],
  ["HAM_TASK_WRITE_BEARER_TOKEN", "GALAXY_DEPLOY_HAM_TASK_WRITE_BEARER_TOKEN"],
  ["HAM_ADMIN_API_BEARER_TOKEN", "GALAXY_DEPLOY_HAM_ADMIN_API_BEARER_TOKEN"],
  ["HYADES_PROGRAM_OPERATOR_BEARER_TOKEN", "GALAXY_DEPLOY_HYADES_PROGRAM_OPERATOR_BEARER_TOKEN"],
  ["HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN", "GALAXY_DEPLOY_HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN"],
])

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

test("Compose projects editable deploy secrets into stable runtime names", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
  const exampleEnv = await readFile(new URL("../.env.example", import.meta.url), "utf8")
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")

  assert.doesNotMatch(compose, /^secrets:/m)
  assert.doesNotMatch(compose, /_FILE\s*:/)
  assert.doesNotMatch(
    compose,
    /\$\{GALAXY_DEPLOY_[^}]+:-\$\{[^}:]+:\?/,
    "Compose eagerly evaluates required legacy fallbacks before deploy aliases",
  )

  for (const [runtimeName, sourceName] of projections) {
    const projection = new RegExp(
      `${escapeRegExp(runtimeName)}: \\$\\{${escapeRegExp(sourceName)}:-\\$\\{${escapeRegExp(runtimeName)}:(?:-|\\?)`,
    )
    assert.match(compose, projection, `${runtimeName} must use its editable deploy source`)
    assert.match(exampleEnv, new RegExp(`^${escapeRegExp(sourceName)}=$`, "m"))
  }

  assert.match(readme, /ordinary editable secrets/)
  assert.match(readme, /unavailable during build/)
  assert.match(readme, /do not lock the source variable/)
})

test("Coolify staging projects required deploy aliases without nested fallbacks", async () => {
  const compose = await readFile(
    new URL("../docker-compose.coolify-staging.yml", import.meta.url),
    "utf8",
  )

  for (const [runtimeName, sourceName] of [
    ["POSTGRES_PASSWORD", "GALAXY_DEPLOY_POSTGRES_PASSWORD"],
    ["DATABASE_MIGRATION_URL", "GALAXY_DEPLOY_DATABASE_MIGRATION_URL"],
    ["DATABASE_URL", "GALAXY_DEPLOY_DATABASE_URL"],
    ["GB_DATABASE_URL", "GALAXY_DEPLOY_GB_DATABASE_URL"],
    ["GALAXY_API_PROXY_TOKEN", "GALAXY_DEPLOY_GALAXY_API_PROXY_TOKEN"],
    ["DOCLING_API_KEY", "GALAXY_DEPLOY_DOCLING_API_KEY"],
    ["DOCLING_SERVE_API_KEY", "GALAXY_DEPLOY_DOCLING_API_KEY"],
    ["MARKITDOWN_PROXY_TOKEN", "GALAXY_DEPLOY_MARKITDOWN_PROXY_TOKEN"],
  ]) {
    assert.match(
      compose,
      new RegExp(
        `${escapeRegExp(runtimeName)}: \\$\\{${escapeRegExp(sourceName)}:\\?`,
      ),
    )
  }

  assert.doesNotMatch(compose, /:-\\$\\{/)
})

test("CI runs the surface, paper, HAM memory, federated graph, object reference, and ELN regression suites", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")

  assert.match(workflow, /run: pnpm test:surfaces/)
  assert.match(workflow, /run: pnpm test:papers/)
  assert.match(workflow, /run: pnpm test:ham-memory/)
  assert.match(workflow, /run: pnpm test:semantic-field/)
  assert.match(workflow, /run: pnpm test:object-references/)
  assert.match(workflow, /run: pnpm test:code-graph/)
  assert.match(workflow, /run: pnpm test:eln/)
  assert.match(
    workflow,
    /^\s+GALAXY_DEPLOY_DOCLING_API_KEY: ci-docling-api-key$/m,
    "the Compose smoke test must provide Docling's required API key",
  )
})

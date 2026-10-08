import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  parseMigrationExecution,
  planConcurrentIndex,
  verifyConcurrentIndex,
} from "./concurrent-index-migration.mjs"

const migrationUrl = new URL("../db/migrations/044_document_chunk_search.sql", import.meta.url)

async function searchMigration() {
  return parseMigrationExecution(await readFile(migrationUrl, "utf8"))
}

function matchingCatalogRow(spec, overrides = {}) {
  return {
    access_method: spec.accessMethod,
    expression: spec.expression,
    index_name: spec.index.name,
    index_schema: spec.index.schema,
    is_ready: true,
    is_valid: true,
    key_attribute_count: 1,
    predicate: spec.predicate,
    table_name: spec.table.name,
    table_schema: spec.table.schema,
    ...overrides,
  }
}

test("ordinary migrations remain transactional by default", async () => {
  const ordinarySql = await readFile(
    new URL("../db/migrations/043_durable_ingestion_source_kinds.sql", import.meta.url),
    "utf8",
  )
  assert.deepEqual(parseMigrationExecution(ordinarySql), { mode: "transactional" })

  const runner = await readFile(new URL("./db-migrate.mjs", import.meta.url), "utf8")
  assert.match(runner, /if \(execution\.mode === "concurrent-index"\)[\s\S]*continue[\s\S]*client\.query\("BEGIN"\)/u)
  assert.match(runner, /pg_advisory_lock/u)
})

test("only the exact directive opts a single index into concurrent execution", async () => {
  const execution = await searchMigration()
  assert.equal(execution.mode, "concurrent-index")
  assert.equal(execution.spec.index.name, "idx_gb_document_chunks_v1_fts_simple")
  assert.equal(execution.spec.table.name, "gb_document_chunks")
  assert.match(execution.sql, /^CREATE INDEX CONCURRENTLY/u)
  assert.doesNotMatch(execution.sql.slice(0, -1), /;/u)

  assert.throws(
    () => parseMigrationExecution("CREATE INDEX CONCURRENTLY surprise ON public.gb_document_chunks (id);"),
    /exact concurrent-index-v1 directive/u,
  )
  assert.throws(
    () => parseMigrationExecution(`-- galaxy-migration: concurrent-index-v2 {}\nCREATE INDEX CONCURRENTLY surprise ON public.gb_document_chunks (id);`),
    /exact concurrent-index-v1 directive/u,
  )
  const migration = await readFile(migrationUrl, "utf8")
  assert.throws(
    () => parseMigrationExecution(migration.replace("text_content))", "lower(text_content)))")),
    /exactly match its validated directive/u,
  )
})

test("a crash-invalid exact index is dropped and recreated, then verified", async () => {
  const { spec } = await searchMigration()
  assert.equal(planConcurrentIndex(spec, null), "create")
  assert.equal(
    planConcurrentIndex(spec, matchingCatalogRow(spec, { is_ready: false, is_valid: false })),
    "drop-and-create",
  )
  assert.equal(planConcurrentIndex(spec, matchingCatalogRow(spec)), "record")
  assert.doesNotThrow(() => verifyConcurrentIndex(spec, matchingCatalogRow(spec)))
  assert.throws(
    () => verifyConcurrentIndex(spec, matchingCatalogRow(spec, { is_valid: false })),
    /not valid and ready/u,
  )
})

test("unexpected same-name indexes fail closed instead of being dropped or recorded", async () => {
  const { spec } = await searchMigration()
  assert.throws(
    () => planConcurrentIndex(spec, matchingCatalogRow(spec, { table_name: "gb_documents" })),
    /different table/u,
  )
  assert.throws(
    () => planConcurrentIndex(spec, matchingCatalogRow(spec, { expression: "lower(text_content)" })),
    /expression does not match/u,
  )
  assert.throws(
    () => planConcurrentIndex(spec, matchingCatalogRow(spec, { predicate: null })),
    /predicate does not match/u,
  )
})

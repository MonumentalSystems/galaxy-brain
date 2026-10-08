import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import pg from "pg"

import {
  parseMigrationExecution,
  planConcurrentIndex,
  verifyConcurrentIndex,
} from "./concurrent-index-migration.mjs"

const { Client } = pg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDirectory = path.join(root, "db", "migrations")
const connectionString = process.env.DATABASE_MIGRATION_URL?.trim()

if (!connectionString) {
  throw new Error("DATABASE_MIGRATION_URL is required")
}

const lockName = "galaxy_brain_schema_migrations"
const connectAttempts = Number(process.env.MIGRATION_CONNECT_ATTEMPTS || 30)
const connectDelayMs = Number(process.env.MIGRATION_CONNECT_DELAY_MS || 2000)
let client
let connected = false

async function inspectConcurrentIndex(spec) {
  const result = await client.query(
    `SELECT index_schema.nspname AS index_schema,
            index_class.relname AS index_name,
            table_schema.nspname AS table_schema,
            table_class.relname AS table_name,
            access_method.amname AS access_method,
            index_catalog.indnkeyatts AS key_attribute_count,
            index_catalog.indisvalid AS is_valid,
            index_catalog.indisready AS is_ready,
            pg_get_indexdef(index_catalog.indexrelid, 1, true) AS expression,
            CASE WHEN index_catalog.indpred IS NULL THEN NULL
                 ELSE pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true)
             END AS predicate
       FROM pg_catalog.pg_class AS index_class
       JOIN pg_catalog.pg_namespace AS index_schema
         ON index_schema.oid = index_class.relnamespace
       JOIN pg_catalog.pg_index AS index_catalog
         ON index_catalog.indexrelid = index_class.oid
       JOIN pg_catalog.pg_class AS table_class
         ON table_class.oid = index_catalog.indrelid
       JOIN pg_catalog.pg_namespace AS table_schema
         ON table_schema.oid = table_class.relnamespace
       JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = index_class.relam
      WHERE index_schema.nspname = $1
        AND index_class.relname = $2`,
    [spec.index.schema, spec.index.name],
  )
  if (result.rowCount > 1) throw new Error("concurrent index lookup returned multiple catalog rows")
  return result.rows[0] ?? null
}

async function applyConcurrentIndexMigration(execution, version, checksum) {
  let catalogRow = await inspectConcurrentIndex(execution.spec)
  const plan = planConcurrentIndex(execution.spec, catalogRow)
  if (plan === "drop-and-create") {
    await client.query(
      `DROP INDEX CONCURRENTLY "${execution.spec.index.schema}"."${execution.spec.index.name}"`,
    )
    catalogRow = null
  }
  if (plan === "create" || plan === "drop-and-create") {
    await client.query(execution.sql)
    catalogRow = await inspectConcurrentIndex(execution.spec)
  }
  verifyConcurrentIndex(execution.spec, catalogRow)

  await client.query("BEGIN")
  try {
    verifyConcurrentIndex(execution.spec, await inspectConcurrentIndex(execution.spec))
    await client.query(
      "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
      [version, checksum],
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

try {
  for (let attempt = 1; attempt <= connectAttempts; attempt += 1) {
    client = new Client({ connectionString })
    try {
      await client.connect()
      connected = true
      break
    } catch (error) {
      await client.end().catch(() => undefined)
      if (attempt === connectAttempts) throw error
      console.log(`database not ready; retrying (${attempt}/${connectAttempts})`)
      await new Promise((resolve) => setTimeout(resolve, connectDelayMs))
    }
  }

  await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName])
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort()

  for (const file of files) {
    const version = file.replace(/\.sql$/, "")
    const sql = await readFile(path.join(migrationsDirectory, file), "utf8")
    const checksum = createHash("sha256").update(sql).digest("hex")
    const existing = await client.query(
      "SELECT checksum FROM public.schema_migrations WHERE version = $1",
      [version],
    )

    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`checksum mismatch for applied migration ${version}`)
      }
      console.log(`already applied: ${version}`)
      continue
    }

    const execution = parseMigrationExecution(sql)
    if (execution.mode === "concurrent-index") {
      await applyConcurrentIndexMigration(execution, version, checksum)
      console.log(`applied concurrent index: ${version}`)
      continue
    }

    await client.query("BEGIN")
    try {
      await client.query(sql)
      await client.query(
        "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
        [version, checksum],
      )
      await client.query("COMMIT")
      console.log(`applied: ${version}`)
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  }
} finally {
  if (connected) {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined)
    await client.end()
  }
}

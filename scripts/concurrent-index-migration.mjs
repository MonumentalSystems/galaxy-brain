const directivePrefix = "-- galaxy-migration: concurrent-index-v1 "
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u
const allowedDirectiveKeys = [
  "accessMethod",
  "expression",
  "index",
  "predicate",
  "table",
]

function parseQualifiedIdentifier(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a qualified identifier`)
  const parts = value.split(".")
  if (parts.length !== 2 || parts.some((part) => !identifierPattern.test(part))) {
    throw new Error(`${field} must be a lowercase schema-qualified identifier`)
  }
  return { schema: parts[0], name: parts[1] }
}

function normalizeCatalogExpression(value) {
  if (value === null) return null
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("concurrent index expression metadata is missing")
  }
  let normalized = value.trim().replace(/\s+/gu, " ")
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    let depth = 0
    let wrapsWholeExpression = true
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index]
      if (char === "(") depth += 1
      if (char === ")") depth -= 1
      if (depth === 0 && index < normalized.length - 1) {
        wrapsWholeExpression = false
        break
      }
    }
    if (!wrapsWholeExpression) break
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized
}

function assertExactKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("concurrent index directive must be a JSON object")
  }
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(allowedDirectiveKeys)) {
    throw new Error(`concurrent index directive keys must be exactly: ${allowedDirectiveKeys.join(", ")}`)
  }
}

export function parseMigrationExecution(sql) {
  if (typeof sql !== "string") throw new TypeError("migration SQL must be a string")
  const firstLineEnd = sql.indexOf("\n")
  const firstLine = (firstLineEnd === -1 ? sql : sql.slice(0, firstLineEnd)).replace(/\r$/u, "")

  if (!firstLine.startsWith(directivePrefix)) {
    if (firstLine.startsWith("-- galaxy-migration:") || /\bCREATE\s+INDEX\s+CONCURRENTLY\b/iu.test(sql)) {
      throw new Error("concurrent index migrations require the exact concurrent-index-v1 directive")
    }
    return { mode: "transactional" }
  }

  let directive
  try {
    directive = JSON.parse(firstLine.slice(directivePrefix.length))
  } catch (error) {
    throw new Error("concurrent index directive must contain valid JSON", { cause: error })
  }
  assertExactKeys(directive)
  const index = parseQualifiedIdentifier(directive.index, "index")
  const table = parseQualifiedIdentifier(directive.table, "table")
  if (index.schema !== table.schema) {
    throw new Error("concurrent index and table must use the same schema")
  }
  if (directive.accessMethod !== "gin") {
    throw new Error("concurrent index accessMethod must be gin")
  }
  const expression = normalizeCatalogExpression(directive.expression)
  const predicate = directive.predicate === null
    ? null
    : normalizeCatalogExpression(directive.predicate)
  const body = (firstLineEnd === -1 ? "" : sql.slice(firstLineEnd + 1)).trim()
  if (!body.endsWith(";") || body.slice(0, -1).includes(";") || /(?:--|\/\*)/u.test(body)) {
    throw new Error("concurrent index migration must contain exactly one uncommented SQL statement")
  }
  const expectedBody = [
    `CREATE INDEX CONCURRENTLY ${index.name}`,
    `ON ${table.schema}.${table.name}`,
    `USING ${directive.accessMethod.toUpperCase()} (${expression})`,
    predicate === null ? ";" : `WHERE ${predicate};`,
  ].join(" ")
  if (body.replace(/\s+/gu, " ") !== expectedBody) {
    throw new Error("concurrent index SQL must exactly match its validated directive")
  }

  return {
    mode: "concurrent-index",
    sql: body,
    spec: {
      accessMethod: directive.accessMethod,
      expression,
      index,
      predicate,
      table,
    },
  }
}

function assertCatalogIdentity(spec, row) {
  if (row.index_schema !== spec.index.schema || row.index_name !== spec.index.name) {
    throw new Error("concurrent index catalog identity does not match its directive")
  }
  if (row.table_schema !== spec.table.schema || row.table_name !== spec.table.name) {
    throw new Error("concurrent index name is occupied by an index on a different table")
  }
  if (row.access_method !== spec.accessMethod || Number(row.key_attribute_count) !== 1) {
    throw new Error("concurrent index access method or key shape does not match its directive")
  }
  if (normalizeCatalogExpression(row.expression) !== spec.expression) {
    throw new Error("concurrent index expression does not match its directive")
  }
  const actualPredicate = row.predicate === null ? null : normalizeCatalogExpression(row.predicate)
  if (actualPredicate !== spec.predicate) {
    throw new Error("concurrent index predicate does not match its directive")
  }
}

export function planConcurrentIndex(spec, row) {
  if (!row) return "create"
  assertCatalogIdentity(spec, row)
  if (!row.is_valid || !row.is_ready) return "drop-and-create"
  return "record"
}

export function verifyConcurrentIndex(spec, row) {
  if (!row) throw new Error("concurrent index is missing after migration")
  assertCatalogIdentity(spec, row)
  if (!row.is_valid || !row.is_ready) {
    throw new Error("concurrent index is not valid and ready after migration")
  }
}

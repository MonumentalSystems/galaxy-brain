import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { Client } from "pg"


const databaseUrl = process.env.CONVERSATION_SNAPSHOT_TEST_URL || process.env.DATABASE_VERIFY_URL || ""

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

async function setTenant(client, tenantId) {
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId])
}

async function createConversation(client, fixture, suffix) {
  const contentHash = digest(suffix)
  const idempotencyKey = `snapshot-${suffix}-${fixture.conversationId}`
  const mutation = {
    kind: "create",
    workspaceId: "snapshot-test",
    title: `Snapshot ${suffix}`,
    goal: "Prove one exported PostgreSQL snapshot remains stable across requests.",
    artifactRefs: [],
    provenance: { provider: "conversation-snapshot-test" },
  }
  await client.query(
    `INSERT INTO gb_conversations (
       id, tenant_id, workspace_id, title, goal, artifact_refs, provenance,
       current_content_hash, created_by_principal_id,
       creation_idempotency_key, creation_request_hash
     ) VALUES ($1, $2, 'snapshot-test', $3, $4, '[]', $5, $6, $7, $8, $9)`,
    [
      fixture.conversationId, fixture.tenantId, mutation.title, mutation.goal,
      mutation.provenance, contentHash, fixture.principalId, idempotencyKey,
      suffix.repeat(64),
    ],
  )
  await client.query(
    `INSERT INTO gb_conversation_revisions (
       tenant_id, conversation_id, version, parent_content_hash, content_hash,
       mutation_kind, mutation_json, idempotency_key, request_hash,
       created_by_principal_id
     ) VALUES ($1, $2, 1, NULL, $3, 'create', $4, $5, $6, $7)`,
    [
      fixture.tenantId, fixture.conversationId, contentHash, mutation,
      idempotencyKey, suffix.repeat(64), fixture.principalId,
    ],
  )
  return contentHash
}

async function visibleHeads(client, tenantId, snapshot, pageLimit = 201) {
  const result = await client.query(
    `WITH visible_creation_candidates AS MATERIALIZED (
       SELECT creation.conversation_id, creation.mutation_json, creation.created_at
         FROM gb_conversation_revisions AS creation
        WHERE creation.tenant_id = $1
          AND creation.version = 1
          AND creation.mutation_kind = 'create'
          AND pg_visible_in_snapshot(
            creation.xmin::text::xid8,
            $2::pg_snapshot
          )
          AND creation.mutation_json->>'workspaceId' = 'snapshot-test'
        ORDER BY creation.conversation_id DESC
        LIMIT $3
     )
     SELECT creation.conversation_id::text, head.version, head.content_hash,
            creation.mutation_json->>'workspaceId' AS workspace_id,
            creation.mutation_json->>'title' AS title
       FROM visible_creation_candidates AS creation
       JOIN LATERAL (
         SELECT revision.version, revision.content_hash, revision.created_at
           FROM gb_conversation_revisions AS revision
          WHERE revision.tenant_id = $1
            AND revision.conversation_id = creation.conversation_id
            AND pg_visible_in_snapshot(
              revision.xmin::text::xid8,
              $2::pg_snapshot
            )
          ORDER BY revision.version DESC
          LIMIT 1
       ) AS head ON TRUE
      ORDER BY creation.conversation_id DESC`,
    [tenantId, snapshot, pageLimit],
  )
  assert.ok(result.rowCount <= pageLimit)
  return new Map(result.rows.map((row) => [row.conversation_id, row]))
}

test("conversation discovery reuses one PostgreSQL visibility snapshot across requests", {
  skip: databaseUrl ? false : "CONVERSATION_SNAPSHOT_TEST_URL is not configured",
}, async () => {
  const tenantId = randomUUID()
  const principalId = randomUUID()
  const visibleConversationId = randomUUID()
  const pendingConversationId = randomUUID()
  const fixture = { tenantId, principalId, conversationId: visibleConversationId }
  const admin = new Client({ connectionString: databaseUrl })
  const pending = new Client({ connectionString: databaseUrl })
  const reader = new Client({ connectionString: databaseUrl })
  const appender = new Client({ connectionString: databaseUrl })
  await Promise.all([admin.connect(), pending.connect(), reader.connect(), appender.connect()])
  try {
    await admin.query(
      `INSERT INTO app_tenants (id, slug, name, status)
       VALUES ($1, $2, 'Conversation snapshot test', 'active')`,
      [tenantId, `snapshot-${tenantId.slice(0, 12)}`],
    )
    await admin.query(
      `INSERT INTO app_principals (id, kind, display_name, status)
       VALUES ($1, 'service', 'Conversation snapshot test', 'active')`,
      [principalId],
    )
    await admin.query(
      `INSERT INTO app_tenant_memberships (tenant_id, principal_id, role)
       VALUES ($1, $2, 'service')`,
      [tenantId, principalId],
    )
    await setTenant(admin, tenantId)
    await admin.query("BEGIN")
    const originalHash = await createConversation(admin, fixture, "a")
    await admin.query("COMMIT")

    await setTenant(pending, tenantId)
    await pending.query("BEGIN")
    await createConversation(
      pending,
      { tenantId, principalId, conversationId: pendingConversationId },
      "b",
    )

    await setTenant(reader, tenantId)
    const snapshot = (await reader.query(
      "SELECT pg_current_snapshot()::text AS snapshot",
    )).rows[0].snapshot
    const firstPage = await visibleHeads(reader, tenantId, snapshot)
    assert.equal(firstPage.get(visibleConversationId)?.version, 1)
    assert.equal(firstPage.has(pendingConversationId), false)

    await pending.query("COMMIT")

    await setTenant(appender, tenantId)
    await appender.query("BEGIN")
    const turnId = randomUUID()
    const turnHash = digest("c")
    const nextHash = digest("d")
    const mutation = {
      turnId,
      parentTurnIds: [],
      message: { role: "assistant", content: "Post-snapshot append" },
      artifactRefs: [],
      provenance: { provider: "conversation-snapshot-test" },
      turnContentHash: turnHash,
    }
    await appender.query(
      `INSERT INTO gb_conversation_turns (
         id, tenant_id, conversation_id, ordinal, introduced_in_version,
         created_by_principal_id
       ) VALUES ($1, $2, $3, 1, 2, $4)`,
      [turnId, tenantId, visibleConversationId, principalId],
    )
    await appender.query(
      `INSERT INTO gb_conversation_turn_revisions (
         tenant_id, conversation_id, turn_id, introduced_in_version, role,
         content, artifact_refs, provenance, content_hash, created_by_principal_id
       ) VALUES ($1, $2, $3, 2, 'assistant', 'Post-snapshot append', '[]', $4, $5, $6)`,
      [
        tenantId, visibleConversationId, turnId,
        mutation.provenance, turnHash, principalId,
      ],
    )
    await appender.query(
      `UPDATE gb_conversations
          SET current_version = 2, current_content_hash = $1, updated_at = now()
        WHERE tenant_id = $2 AND id = $3`,
      [nextHash, tenantId, visibleConversationId],
    )
    await appender.query(
      `INSERT INTO gb_conversation_revisions (
         tenant_id, conversation_id, version, parent_content_hash, content_hash,
         mutation_kind, mutation_json, idempotency_key, request_hash,
         created_by_principal_id
       ) VALUES ($1, $2, 2, $3, $4, 'append', $5, $6, $7, $8)`,
      [
        tenantId, visibleConversationId, originalHash, nextHash, mutation,
        `snapshot-append-${visibleConversationId}`, "d".repeat(64), principalId,
      ],
    )
    await appender.query("COMMIT")

    const laterPage = await visibleHeads(reader, tenantId, snapshot)
    assert.equal(laterPage.has(pendingConversationId), false)
    assert.deepEqual(laterPage.get(visibleConversationId), {
      conversation_id: visibleConversationId,
      version: 1,
      content_hash: originalHash,
      workspace_id: "snapshot-test",
      title: "Snapshot a",
    })
  } finally {
    await Promise.allSettled([
      pending.query("ROLLBACK"),
      appender.query("ROLLBACK"),
    ])
    await Promise.allSettled([admin.end(), pending.end(), reader.end(), appender.end()])
  }
})

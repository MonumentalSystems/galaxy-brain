# Neon to dedicated PostgreSQL migration

This runbook consolidates Galaxy Brain into one dedicated PostgreSQL/PGVector 16 database. It supports either preserving Neon-hosted `app_*` authentication data (`neon` mode) or deliberately creating empty authentication tables when Neon is unrecoverable (`fresh-auth` mode). Both modes preserve the existing `gb_*` ELN data. It does not reuse HAM's database or Coolify's control-plane database.

The target model is multi-tenant from the first migration. A tenant owns data; a principal acts within a tenant. Human browser sessions retain the Nostr public key that proved the session. Agents are externally identified by distinct Nostr public keys and use replay-safe NIP-98 request signatures; UUID principal IDs remain private relational surrogates. Migration 011 disables legacy agents without a public key and revokes their `gbk_` bearer tokens. The internal ELN proxy forwards validated tenant/principal identity, and PostgreSQL row-level security provides a second tenant-isolation boundary. Legacy `gb_*` rows are assigned to the bootstrap `default` tenant and become visible to its newly registered owner.

The migration is deliberately split into export, restore, validation, and cutover. Never point `DATABASE_URL` at an empty target and never treat a named Docker volume as a backup.

## Preconditions

- In `neon` mode, restore or temporarily upgrade the Neon compute so an unpooled connection can complete a consistent `pg_dump`.
- In `fresh-auth` mode, record explicit owner acceptance that users, sessions, passkeys, Nostr keys, and reset state will be recreated. This mode never attempts to read Neon.
- Provision a standalone PostgreSQL/PGVector 16 target on the private Coolify network. Do not publish port 5432.
- Create distinct migration, web-runtime, API-runtime, and backup roles. Only the migration role owns the schema and can perform DDL.
- Provision a separate standalone database for staging.
- Configure encrypted off-host backups before cutover and prove an isolated restore.
- Install PostgreSQL 16 client tools on the operations host. The client major version must be at least the source server major version.

After migrations, grant the web role DML on `app_*` tables and their sequences,
the API role DML on `gb_*` tables and their sequences, the API role `SELECT` on
`app_tenants`, `app_principals`, and `app_tenant_memberships` for trusted
principal validation, and both runtime roles `SELECT` on `schema_migrations`.
Revoke schema creation and table ownership from
both runtime roles. The API runtime role must not have `BYPASSRLS`, be a
superuser, own any tenant table, or be able to assume a privileged/table-owner
role. API startup fails closed when these conditions are not met. Validate these
grants with the actual Coolify credentials; role labels and comments are not
proof of authority.

The three source/target URLs are passed only through environment variables. The transfer script writes them to a mode-0600 temporary libpq service file so credentials do not appear in `pg_dump`, `pg_restore`, or `psql` process arguments.

## 1. Select and record the source mode

Use the preserving path whenever Neon is readable:

```console
export MIGRATION_SOURCE_MODE=neon
```

When the owner has explicitly accepted recreating all authentication state:

```console
export MIGRATION_SOURCE_MODE=fresh-auth
```

The export records this choice in a checksummed `MIGRATION-MODE` artifact. Restore fails closed if the selected mode differs from the exported mode. A Neon connection failure never automatically selects `fresh-auth`.

## 2. Export without changing the source

Choose a new mode-0700 artifact directory on encrypted storage, then set:

```console
export MIGRATION_ARTIFACT_DIR=/explicit/encrypted/path/galaxy-migration-YYYYMMDD
export GALAXY_API_SOURCE_DATABASE_URL='postgresql://...current Galaxy API database...'
scripts/transfer-database.sh export
```

Set `NEON_SOURCE_DATABASE_URL` only in `neon` mode. `fresh-auth` mode exports only `gb_*` ELN data and does not require a target URL during export.

Copy every generated `.dump` file together with `MIGRATION-MODE` and
`SHA256SUMS` to encrypted off-host storage. The manifest uses portable
basenames, so the artifact set may be restored from a different absolute
directory. Verify the checksums after copying. Do not log, commit, or paste any
database URL.

## 3. Restore into an isolated empty target

The restore refuses a target containing any `app_*` or `gb_*` tables. Resolve the exact target independently, verify that it is not production or another service database, then run:

```console
export RESTORE_CONFIRMATION=restore-to-empty-galaxy-target
export GALAXY_TARGET_DATABASE_URL='postgresql://...new migration role...'
scripts/transfer-database.sh restore
```

The restore loads the available dumps, then applies ordered transactional migrations under a PostgreSQL advisory lock. In `fresh-auth` mode, this creates empty `app_*` tables and restores `gb_*`. An applied migration whose checksum changes fails closed.

## 4. Validate before the write freeze

```console
scripts/transfer-database.sh verify
```

In `neon` mode, validation compares exact per-table row counts and a SHA-256 fingerprint of user/passkey/Nostr primary keys without printing those identifiers. In `fresh-auth` mode, it compares exact `gb_*` row counts and fails unless every required `app_*` table exists and is empty. Both modes check the migration ledger and unvalidated foreign keys.

Perform an isolated restore from the target's scheduled backup and repeat validation against that restored database.

## 5. Short write freeze and final export

Put Galaxy Brain into a visible maintenance/write-freeze state. Re-run export into a new artifact directory, restore into a newly empty final target, and repeat every validation. Record dump checksums, target identity, source/target table counts, migration versions, deployed source commit, and timestamps.

## 6. Cutover

Configure Coolify runtime-only secrets:

- `DATABASE_MIGRATION_URL`: migration-role URL, available only to the one-shot `migrate` service.
- `DATABASE_URL`: web-runtime role.
- `GB_DATABASE_URL`: API-runtime role.

Bind every deployment-global integration before enabling more than one Galaxy
tenant. `HAM_ADMIN_GALAXY_TENANT_ID` and
`HAM_ADMIN_GALAXY_PRINCIPAL_ID` must identify the one exact Galaxy owner allowed
to exercise the HAM administrator credential. `HAM_TASK_GALAXY_TENANT_ID` must
identify the only Galaxy tenant allowed to use the configured
`HAM_TASK_PROJECT_REF` and its observer/publisher credentials. Filesystem
datasources remain disabled unless `GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT`
maps an exact Galaxy tenant UUID to non-root absolute container paths. Do not
reuse a root mapping, HAM project credential, or HAM administrator credential
across tenants.

All three select the same dedicated production database but use different roles. Deploy the exact reviewed commit. The web and API containers wait for the migration job to complete and then verify the migration ledger; neither runtime performs DDL.

Verify public root and `/api/health`, unauthenticated workspace redirect, owner password login, passkey login, Nostr login, authenticated workspace and ELN reads/writes, HAM task-board reads, container health, and scheduled backup status.

In `fresh-auth` mode, open registration only with a newly generated one-time invite code, register the owner, close/rotate the invite immediately, then enroll replacement passkey and Nostr credentials. Verify that the owner can read and update every restored ELN record before declaring cutover complete.

After owner validation, create or load a distinct Nostr identity on each agent
machine as described in `llms.txt`, keeping its nsec agent-side. A
Nostr-authenticated tenant owner registers only the agent's public key, handle,
display name, and least-privilege scopes through `POST /api/agents`; the endpoint
does not issue a bearer token. The agent signs each request with a fresh NIP-98
proof. Disable the agent with `DELETE /api/agents/{pubkey}` to revoke that
Galaxy-local registration. Test two tenants with different principals and prove
that neither the API nor a direct runtime-role query can cross the PostgreSQL
row-level-security boundary.

Human sessions remember an explicit default tenant and bind every session to
one active membership. `GET /api/tenants` lists active memberships, and a
same-origin `POST /api/tenants/{tenantId}/select` switches the current session
and remembered default. Suspended tenants and disabled principals cannot be
selected or used to create a session. If a remembered default tenant is later
suspended, the next login deterministically selects and remembers another
active membership; an explicitly requested inactive tenant still fails closed.

## 7. Rollback and retirement

If validation fails, restore the recorded prior application image and keep the PostgreSQL target isolated while diagnosing; do not write independently to multiple databases. In `neon` mode, retain Neon read-only for the agreed rollback window and take a final checksummed dump before revoking its credential. In `fresh-auth` mode, remove Neon environment variables only after PostgreSQL health, owner registration, restored ELN reads/writes, and an isolated backup restore all pass. Delete the Neon project only as a separate, explicitly resolved retirement action after the rollback window.

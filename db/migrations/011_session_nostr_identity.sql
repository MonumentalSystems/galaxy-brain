ALTER TABLE app_sessions
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT REFERENCES app_nostr_keys(pubkey) ON DELETE CASCADE;

ALTER TABLE app_sessions
  DROP CONSTRAINT IF EXISTS app_sessions_auth_method_check,
  DROP CONSTRAINT IF EXISTS app_sessions_nostr_identity_check;

ALTER TABLE app_sessions
  ADD CONSTRAINT app_sessions_auth_method_check
    CHECK (auth_method IN ('password', 'passkey', 'nostr')),
  ADD CONSTRAINT app_sessions_nostr_identity_check
    CHECK (
      (auth_method = 'nostr' AND nostr_pubkey IS NOT NULL)
      OR (auth_method <> 'nostr' AND nostr_pubkey IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_app_sessions_nostr_pubkey
  ON app_sessions(nostr_pubkey)
  WHERE nostr_pubkey IS NOT NULL;

ALTER TABLE app_agents
  ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT
    CHECK (nostr_pubkey ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['eln:read', 'eln:write'],
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD CONSTRAINT app_agents_nostr_pubkey_key UNIQUE (nostr_pubkey);

UPDATE app_principals AS principal
   SET status = 'disabled',
       updated_at = now()
  FROM app_agents AS agent
 WHERE agent.principal_id = principal.id
   AND agent.nostr_pubkey IS NULL
   AND principal.status = 'active';

UPDATE app_api_tokens AS token
   SET revoked_at = COALESCE(token.revoked_at, now())
 WHERE EXISTS (
   SELECT 1
     FROM app_agents AS agent
    WHERE agent.principal_id = token.principal_id
      AND agent.tenant_id = token.tenant_id
 );

CREATE OR REPLACE FUNCTION app_reject_shared_human_agent_nostr_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'app_nostr_keys' THEN
    IF EXISTS (SELECT 1 FROM app_agents WHERE nostr_pubkey = NEW.pubkey) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'human and agent Nostr keys must be distinct';
    END IF;
  ELSIF NEW.nostr_pubkey IS NOT NULL
    AND EXISTS (SELECT 1 FROM app_nostr_keys WHERE pubkey = NEW.nostr_pubkey) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'human and agent Nostr keys must be distinct';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS app_nostr_keys_distinct_actor_key ON app_nostr_keys;
CREATE TRIGGER app_nostr_keys_distinct_actor_key
BEFORE INSERT OR UPDATE OF pubkey ON app_nostr_keys
FOR EACH ROW EXECUTE FUNCTION app_reject_shared_human_agent_nostr_key();

DROP TRIGGER IF EXISTS app_agents_distinct_actor_key ON app_agents;
CREATE TRIGGER app_agents_distinct_actor_key
BEFORE INSERT OR UPDATE OF nostr_pubkey ON app_agents
FOR EACH ROW EXECUTE FUNCTION app_reject_shared_human_agent_nostr_key();

CREATE TABLE IF NOT EXISTS app_nostr_auth_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  pubkey TEXT NOT NULL REFERENCES app_agents(nostr_pubkey) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_app_nostr_auth_events_expires_at
  ON app_nostr_auth_events(expires_at);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, DELETE ON TABLE public.app_nostr_auth_events TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
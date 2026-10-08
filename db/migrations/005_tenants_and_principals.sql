CREATE TABLE app_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_tenants (id, slug, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Galaxy Brain')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE app_principals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_tenant_memberships (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE CASCADE,
  principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'agent', 'service')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);

ALTER TABLE app_users
  ADD COLUMN principal_id UUID,
  ADD COLUMN default_tenant_id UUID;

INSERT INTO app_principals (id, kind, display_name, created_at, updated_at)
SELECT id, 'human', COALESCE(NULLIF(name, ''), email), created_at, updated_at
FROM app_users
ON CONFLICT (id) DO NOTHING;

UPDATE app_users SET principal_id = id WHERE principal_id IS NULL;

ALTER TABLE app_users
  ALTER COLUMN principal_id SET NOT NULL,
  ADD CONSTRAINT app_users_principal_id_key UNIQUE (principal_id),
  ADD CONSTRAINT app_users_principal_id_fkey
    FOREIGN KEY (principal_id) REFERENCES app_principals(id) ON DELETE RESTRICT;

INSERT INTO app_tenant_memberships (tenant_id, principal_id, role, created_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  principal_id,
  CASE WHEN row_number() OVER (ORDER BY created_at, id) = 1 THEN 'owner' ELSE 'member' END,
  created_at
FROM app_users
ON CONFLICT (tenant_id, principal_id) DO NOTHING;

UPDATE app_users
SET default_tenant_id = '00000000-0000-4000-8000-000000000001'
WHERE default_tenant_id IS NULL;

ALTER TABLE app_users
  ALTER COLUMN default_tenant_id SET NOT NULL,
  ADD CONSTRAINT app_users_default_membership_fkey
    FOREIGN KEY (default_tenant_id, principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;

ALTER TABLE app_sessions ADD COLUMN tenant_id UUID;

UPDATE app_sessions s
SET tenant_id = m.tenant_id
FROM app_users u
JOIN app_tenant_memberships m ON m.principal_id = u.principal_id
WHERE s.user_id = u.id AND s.tenant_id IS NULL;

ALTER TABLE app_sessions
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT app_sessions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE CASCADE;

CREATE INDEX idx_app_sessions_tenant_id ON app_sessions(tenant_id);
CREATE INDEX idx_app_memberships_principal_id ON app_tenant_memberships(principal_id);

CREATE TABLE app_agents (
  principal_id UUID PRIMARY KEY REFERENCES app_principals(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  handle TEXT NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  created_by_principal_id UUID REFERENCES app_principals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, handle),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE app_api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  principal_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE CASCADE
);

CREATE INDEX idx_app_api_tokens_principal_id ON app_api_tokens(principal_id);
CREATE INDEX idx_app_api_tokens_tenant_id ON app_api_tokens(tenant_id);

ALTER TABLE gb_experiments
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_hypotheses
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_experiment_metrics
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_datasource_connections
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_datasource_sync_runs
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_share_snapshots
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;
ALTER TABLE gb_node_revisions
  ADD COLUMN tenant_id UUID,
  ADD COLUMN created_by_principal_id UUID;

UPDATE gb_experiments SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_hypotheses SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_experiment_metrics SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_datasource_connections SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_datasource_sync_runs SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_share_snapshots SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
UPDATE gb_node_revisions SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;

ALTER TABLE gb_experiments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_hypotheses ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_experiment_metrics ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_datasource_connections ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_datasource_sync_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_share_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE gb_node_revisions ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE gb_experiments ADD CONSTRAINT gb_experiments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_hypotheses ADD CONSTRAINT gb_hypotheses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_experiment_metrics ADD CONSTRAINT gb_experiment_metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_datasource_connections ADD CONSTRAINT gb_datasource_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_datasource_sync_runs ADD CONSTRAINT gb_datasource_sync_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_share_snapshots ADD CONSTRAINT gb_share_snapshots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;
ALTER TABLE gb_node_revisions ADD CONSTRAINT gb_node_revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES app_tenants(id) ON DELETE RESTRICT;

ALTER TABLE gb_experiments ADD CONSTRAINT gb_experiments_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE gb_hypotheses ADD CONSTRAINT gb_hypotheses_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE gb_datasource_connections ADD CONSTRAINT gb_datasource_connections_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE gb_experiment_metrics ADD CONSTRAINT gb_metrics_tenant_experiment_fkey
  FOREIGN KEY (tenant_id, experiment_id) REFERENCES gb_experiments(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE gb_datasource_sync_runs ADD CONSTRAINT gb_sync_runs_tenant_connection_fkey
  FOREIGN KEY (tenant_id, connection_id) REFERENCES gb_datasource_connections(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE gb_hypotheses ADD CONSTRAINT gb_hypotheses_tenant_superseded_fkey
  FOREIGN KEY (tenant_id, superseded_by) REFERENCES gb_hypotheses(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE gb_experiments ADD CONSTRAINT gb_experiments_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_hypotheses ADD CONSTRAINT gb_hypotheses_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_experiment_metrics ADD CONSTRAINT gb_metrics_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_datasource_connections ADD CONSTRAINT gb_connections_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_datasource_sync_runs ADD CONSTRAINT gb_sync_runs_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_share_snapshots ADD CONSTRAINT gb_snapshots_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;
ALTER TABLE gb_node_revisions ADD CONSTRAINT gb_revisions_creator_membership_fkey
  FOREIGN KEY (tenant_id, created_by_principal_id) REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT;

CREATE INDEX idx_gb_experiments_tenant ON gb_experiments(tenant_id, updated_at DESC);
CREATE INDEX idx_gb_hypotheses_tenant ON gb_hypotheses(tenant_id, updated_at DESC);
CREATE INDEX idx_gb_metrics_tenant ON gb_experiment_metrics(tenant_id, experiment_id);
CREATE INDEX idx_gb_datasource_connections_tenant ON gb_datasource_connections(tenant_id, updated_at DESC);
CREATE INDEX idx_gb_datasource_sync_runs_tenant ON gb_datasource_sync_runs(tenant_id, started_at DESC);
CREATE INDEX idx_gb_share_snapshots_tenant ON gb_share_snapshots(tenant_id, created_at DESC);
CREATE INDEX idx_gb_node_revisions_tenant ON gb_node_revisions(tenant_id, node_id, timestamp DESC);

ALTER TABLE gb_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_experiment_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_datasource_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_datasource_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_share_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_node_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_experiments_tenant_isolation ON gb_experiments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_hypotheses_tenant_isolation ON gb_hypotheses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_experiment_metrics_tenant_isolation ON gb_experiment_metrics
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_datasource_connections_tenant_isolation ON gb_datasource_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_datasource_sync_runs_tenant_isolation ON gb_datasource_sync_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_share_snapshots_tenant_isolation ON gb_share_snapshots
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_node_revisions_tenant_isolation ON gb_node_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

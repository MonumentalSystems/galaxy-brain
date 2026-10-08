CREATE TABLE IF NOT EXISTS gb_experiments (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis','running','complete','abandoned')),
    hypothesis TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT '',
    config_snapshot JSONB NOT NULL DEFAULT '{}',
    wandb_run_id TEXT,
    wandb_project TEXT,
    local_run_path TEXT,
    results TEXT NOT NULL DEFAULT '',
    interpretation TEXT NOT NULL DEFAULT '',
    conclusion TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT 'general',
    tags TEXT[] NOT NULL DEFAULT '{}',
    linked_experiments TEXT[] NOT NULL DEFAULT '{}',
    linked_papers TEXT[] NOT NULL DEFAULT '{}',
    ham_node_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gb_hypotheses (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','refuted','superseded')),
    confidence FLOAT NOT NULL DEFAULT 0.5,
    domain TEXT NOT NULL DEFAULT 'general',
    supporting_experiments TEXT[] NOT NULL DEFAULT '{}',
    refuting_experiments TEXT[] NOT NULL DEFAULT '{}',
    superseded_by TEXT REFERENCES gb_hypotheses(id),
    ham_node_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gb_experiment_metrics (
    id BIGSERIAL PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES gb_experiments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value FLOAT NOT NULL,
    step INTEGER,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('wandb','local','manual'))
);

CREATE INDEX IF NOT EXISTS idx_gb_experiments_status ON gb_experiments(status);
CREATE INDEX IF NOT EXISTS idx_gb_experiments_domain ON gb_experiments(domain);
CREATE INDEX IF NOT EXISTS idx_gb_experiments_user_id ON gb_experiments(user_id);
CREATE INDEX IF NOT EXISTS idx_gb_experiments_updated ON gb_experiments(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gb_metrics_experiment ON gb_experiment_metrics(experiment_id);
CREATE INDEX IF NOT EXISTS idx_gb_hypotheses_status ON gb_hypotheses(status);
CREATE INDEX IF NOT EXISTS idx_gb_hypotheses_domain ON gb_hypotheses(domain);
CREATE INDEX IF NOT EXISTS idx_gb_hypotheses_user_id ON gb_hypotheses(user_id);

CREATE TABLE IF NOT EXISTS gb_datasource_plugins (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('filesystem','cloud','api','reference')),
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','path','token','oauth')),
    is_builtin BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gb_datasource_connections (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    plugin_id TEXT NOT NULL REFERENCES gb_datasource_plugins(id) ON DELETE RESTRICT,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
    root_path TEXT,
    config JSONB NOT NULL DEFAULT '{}',
    last_sync_cursor TEXT,
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gb_datasource_sync_runs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    connection_id TEXT NOT NULL REFERENCES gb_datasource_connections(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
    imported_count INTEGER NOT NULL DEFAULT 0,
    next_cursor TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS gb_share_snapshots (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    target_type TEXT NOT NULL CHECK (target_type IN ('surface','component','node')),
    target_id TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT 'public-read' CHECK (access IN ('public-read')),
    snapshot_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gb_node_revisions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    timestamp TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL DEFAULT 'update',
    summary TEXT NOT NULL DEFAULT '',
    changed_fields TEXT[] NOT NULL DEFAULT '{}',
    snapshot_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gb_datasource_connections_plugin ON gb_datasource_connections(plugin_id);
CREATE INDEX IF NOT EXISTS idx_gb_datasource_connections_status ON gb_datasource_connections(status);
CREATE INDEX IF NOT EXISTS idx_gb_datasource_sync_runs_connection ON gb_datasource_sync_runs(connection_id);
CREATE INDEX IF NOT EXISTS idx_gb_datasource_sync_runs_started ON gb_datasource_sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_gb_share_snapshots_target ON gb_share_snapshots(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_gb_node_revisions_node ON gb_node_revisions(node_id, timestamp DESC);

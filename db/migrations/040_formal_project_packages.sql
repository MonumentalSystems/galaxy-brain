-- Immutable, tenant-owned Rosetta formal-project package registrations.
-- A package binds exact source/projection/correspondence artifacts to one
-- passive proof graph. It never creates workspaces, claims, runs, missions,
-- verification receipts, or publication state.

CREATE TABLE gb_formal_project_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  schema_id TEXT NOT NULL DEFAULT 'rosetta.formal-project-package.v1'
    CHECK (schema_id = 'rosetta.formal-project-package.v1'),
  project_id TEXT NOT NULL CHECK (
    char_length(project_id) BETWEEN 1 AND 512
    AND project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  repository TEXT NOT NULL CHECK (char_length(repository) BETWEEN 1 AND 500),
  commit_oid TEXT NOT NULL CHECK (commit_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  tree_oid TEXT NOT NULL CHECK (tree_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  lean_toolchain TEXT NOT NULL CHECK (char_length(lean_toolchain) BETWEEN 1 AND 200),
  mathlib_revision TEXT NOT NULL CHECK (mathlib_revision ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  conversion_profile TEXT NOT NULL CHECK (
    conversion_profile = 'rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1'
  ),
  manifest_artifact_id UUID NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_json JSONB NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  authored_dag_artifact_id UUID NOT NULL,
  authored_dag_sha256 TEXT NOT NULL CHECK (authored_dag_sha256 ~ '^[0-9a-f]{64}$'),
  repository_field_graph_id TEXT NOT NULL CHECK (char_length(repository_field_graph_id) BETWEEN 1 AND 512),
  repository_field_dag_sha256 TEXT NOT NULL CHECK (repository_field_dag_sha256 ~ '^[0-9a-f]{64}$'),
  correspondence_artifact_id UUID NOT NULL,
  correspondence_sha256 TEXT NOT NULL CHECK (correspondence_sha256 ~ '^[0-9a-f]{64}$'),
  formal_graph_sha256 TEXT NOT NULL CHECK (formal_graph_sha256 ~ '^[0-9a-f]{64}$'),
  repository_graph_sha256 TEXT NOT NULL CHECK (repository_graph_sha256 ~ '^[0-9a-f]{64}$'),
  registered_by_principal_id UUID NOT NULL,
  registered_by_nostr_pubkey TEXT NOT NULL CHECK (registered_by_nostr_pubkey ~ '^[0-9a-f]{64}$'),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, manifest_sha256),
  FOREIGN KEY (tenant_id, manifest_artifact_id, manifest_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authored_dag_artifact_id, authored_dag_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, correspondence_artifact_id, correspondence_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, repository_field_graph_id, repository_field_dag_sha256)
    REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, registered_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION gb_verify_formal_project_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_artifact RECORD;
  authored_artifact RECORD;
  correspondence_artifact RECORD;
  projected_graph RECORD;
  parsed JSONB;
  authored JSONB;
  correspondence JSONB;
BEGIN
  SELECT media_type, byte_size, content_bytes INTO manifest_artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.manifest_artifact_id
     AND content_sha256 = NEW.manifest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project manifest artifact is unavailable';
  END IF;
  IF manifest_artifact.media_type <> 'application/json' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project manifest artifact must be JSON';
  END IF;
  IF manifest_artifact.byte_size < 1 OR manifest_artifact.byte_size > 65536 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project manifest artifact exceeds 64 KiB';
  END IF;
  BEGIN
    parsed := convert_from(manifest_artifact.content_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project manifest is not UTF-8 JSON';
  END;
  IF parsed <> NEW.manifest_json THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project manifest JSON does not match exact bytes';
  END IF;
  SELECT graph_kind, graph_json INTO projected_graph
    FROM gb_proof_graphs
   WHERE tenant_id = NEW.tenant_id
     AND graph_id = NEW.repository_field_graph_id
     AND content_sha256 = NEW.repository_field_dag_sha256;
  IF NOT FOUND OR projected_graph.graph_kind <> 'repository-field' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project package requires a passive repository-field graph';
  END IF;
  IF COALESCE(projected_graph.graph_json #>> '{source_revision,repository}', '') <> NEW.repository
     OR COALESCE(projected_graph.graph_json #>> '{source_revision,commit}', '') <> NEW.commit_oid
     OR COALESCE(projected_graph.graph_json #>> '{source_revision,tree}', '') <> NEW.tree_oid
     OR COALESCE(projected_graph.graph_json #>> '{source_revision,lean_toolchain}', '') <> NEW.lean_toolchain
     OR COALESCE(projected_graph.graph_json #>> '{source_revision,mathlib_revision}', '') <> NEW.mathlib_revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project projection source revision does not match the package';
  END IF;
  SELECT media_type, byte_size, content_bytes INTO authored_artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.authored_dag_artifact_id
     AND content_sha256 = NEW.authored_dag_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authored conceptual DAG artifact is unavailable';
  END IF;
  SELECT media_type, byte_size, content_bytes INTO correspondence_artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.correspondence_artifact_id
     AND content_sha256 = NEW.correspondence_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal correspondence artifact is unavailable';
  END IF;
  IF authored_artifact.media_type <> 'application/json'
     OR correspondence_artifact.media_type <> 'application/json' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project compact artifacts must be JSON';
  END IF;
  IF authored_artifact.byte_size < 1 OR authored_artifact.byte_size > 16777216
     OR correspondence_artifact.byte_size < 1 OR correspondence_artifact.byte_size > 16777216 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project compact artifact exceeds 16 MiB';
  END IF;
  BEGIN
    authored := convert_from(authored_artifact.content_bytes, 'UTF8')::jsonb;
    correspondence := convert_from(correspondence_artifact.content_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project compact artifacts are not UTF-8 JSON';
  END;
  IF COALESCE(authored ->> 'schemaVersion', '') <> 'rosetta-authored-conceptual-dag/1.0.0'
     OR COALESCE(authored ->> 'project', '') <> NEW.project_id
     OR COALESCE(authored ->> 'revision', '') <> NEW.commit_oid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authored conceptual DAG does not match the package revision';
  END IF;
  IF COALESCE(correspondence ->> 'schemaVersion', '') <> 'rosetta-authored-formal-correspondence/1.0.0'
     OR COALESCE(correspondence ->> 'project', '') <> NEW.project_id
     OR COALESCE(correspondence ->> 'revision', '') <> NEW.commit_oid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal correspondence does not match the package revision';
  END IF;
  IF COALESCE(parsed ->> 'schemaId', '') <> NEW.schema_id
     OR COALESCE(parsed ->> 'projectId', '') <> NEW.project_id
     OR COALESCE(parsed ->> 'repository', '') <> NEW.repository
     OR COALESCE(parsed ->> 'commit', '') <> NEW.commit_oid
     OR COALESCE(parsed ->> 'tree', '') <> NEW.tree_oid
     OR COALESCE(parsed #>> '{environment,leanToolchain}', '') <> NEW.lean_toolchain
     OR COALESCE(parsed #>> '{environment,mathlibRevision}', '') <> NEW.mathlib_revision
     OR COALESCE(parsed ->> 'conversionProfile', '') <> NEW.conversion_profile
     OR COALESCE(parsed #>> '{artifacts,formalGraph,sha256}', '') <> NEW.formal_graph_sha256
     OR COALESCE(parsed #>> '{artifacts,repositoryGraph,sha256}', '') <> NEW.repository_graph_sha256
     OR COALESCE(parsed #>> '{artifacts,authoredConceptualDag,sha256}', '') <> NEW.authored_dag_sha256
     OR COALESCE(parsed #>> '{artifacts,repositoryFieldDag,sha256}', '') <> NEW.repository_field_dag_sha256
     OR COALESCE(parsed #>> '{artifacts,correspondence,sha256}', '') <> NEW.correspondence_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal project package metadata does not match its manifest';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_formal_project_packages_verify
BEFORE INSERT ON gb_formal_project_packages
FOR EACH ROW EXECUTE FUNCTION gb_verify_formal_project_package();

CREATE OR REPLACE FUNCTION gb_reject_formal_project_package_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'formal project packages are append-only';
END;
$$;

CREATE TRIGGER gb_formal_project_packages_append_only
BEFORE UPDATE OR DELETE ON gb_formal_project_packages
FOR EACH ROW EXECUTE FUNCTION gb_reject_formal_project_package_mutation();

CREATE INDEX idx_gb_formal_project_packages_project
  ON gb_formal_project_packages(tenant_id, project_id, registered_at DESC, manifest_sha256);

ALTER TABLE gb_formal_project_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_formal_project_packages FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_formal_project_packages_tenant_isolation ON gb_formal_project_packages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_formal_project_packages TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_formal_project_packages FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;

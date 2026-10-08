CREATE TABLE gb_papers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  created_by_principal_id UUID NOT NULL,
  arxiv_id TEXT NOT NULL CHECK (arxiv_id ~ '^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})$'),
  arxiv_version INTEGER NOT NULL CHECK (arxiv_version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1000),
  abstract TEXT NOT NULL CHECK (char_length(abstract) <= 100000),
  authors JSONB NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  published_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  abs_url TEXT NOT NULL,
  pdf_url TEXT NOT NULL,
  doi TEXT,
  journal_ref TEXT,
  license_url TEXT,
  metadata_hash TEXT NOT NULL CHECK (metadata_hash ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, arxiv_id),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_paper_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_id UUID NOT NULL,
  arxiv_version INTEGER NOT NULL CHECK (arxiv_version > 0),
  metadata_hash TEXT NOT NULL CHECK (metadata_hash ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL,
  created_by_principal_id UUID NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, paper_id, metadata_hash),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES gb_papers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_paper_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_id UUID NOT NULL,
  paper_revision_id UUID NOT NULL,
  created_by_principal_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'comment', 'ink')),
  page_number INTEGER NOT NULL CHECK (page_number > 0 AND page_number <= 100000),
  anchor JSONB NOT NULL,
  body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  color TEXT NOT NULL DEFAULT '#facc15' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  lens TEXT NOT NULL DEFAULT 'analysis' CHECK (lens IN ('proof', 'audit', 'analysis')),
  semantic_role TEXT NOT NULL DEFAULT 'note' CHECK (semantic_role IN ('claim', 'evidence', 'note')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES gb_papers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, paper_revision_id) REFERENCES gb_paper_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_paper_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_id UUID NOT NULL,
  source_annotation_id UUID,
  created_by_principal_id UUID NOT NULL,
  statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 20000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'supported', 'refuted', 'mixed')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES gb_papers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_annotation_id) REFERENCES gb_paper_annotations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_claim_evidence_links (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  claim_id UUID NOT NULL,
  annotation_id UUID NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'refutes', 'context')),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, claim_id, annotation_id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES gb_paper_claims(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, annotation_id) REFERENCES gb_paper_annotations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_paper_task_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_id UUID NOT NULL,
  annotation_id UUID,
  claim_id UUID,
  ham_task_id TEXT NOT NULL CHECK (char_length(ham_task_id) BETWEEN 1 AND 200),
  parent_ham_task_id TEXT CHECK (char_length(parent_ham_task_id) BETWEEN 1 AND 200),
  relation TEXT NOT NULL CHECK (relation IN ('document-task', 'subtask')),
  title_snapshot TEXT NOT NULL CHECK (char_length(title_snapshot) BETWEEN 1 AND 200),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ham_task_id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES gb_papers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, annotation_id) REFERENCES gb_paper_annotations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, claim_id) REFERENCES gb_paper_claims(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_papers_updated ON gb_papers(tenant_id, updated_at DESC);
CREATE INDEX idx_gb_paper_revisions_paper ON gb_paper_revisions(tenant_id, paper_id, imported_at DESC);
CREATE INDEX idx_gb_paper_annotations_paper ON gb_paper_annotations(tenant_id, paper_id, paper_revision_id, page_number, created_at);
CREATE INDEX idx_gb_paper_claims_paper ON gb_paper_claims(tenant_id, paper_id, updated_at DESC);
CREATE INDEX idx_gb_paper_task_links_paper ON gb_paper_task_links(tenant_id, paper_id, created_at);

ALTER TABLE gb_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_paper_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_paper_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_paper_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_claim_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_paper_task_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_papers_tenant_isolation ON gb_papers USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_paper_revisions_tenant_isolation ON gb_paper_revisions USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_paper_annotations_tenant_isolation ON gb_paper_annotations USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_paper_claims_tenant_isolation ON gb_paper_claims USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_claim_evidence_links_tenant_isolation ON gb_claim_evidence_links USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_paper_task_links_tenant_isolation ON gb_paper_task_links USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gb_papers, public.gb_paper_revisions, public.gb_paper_annotations, public.gb_paper_claims, public.gb_claim_evidence_links, public.gb_paper_task_links TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;

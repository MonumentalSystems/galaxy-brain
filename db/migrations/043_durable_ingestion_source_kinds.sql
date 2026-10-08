-- Match the durable-ingestion database constraint to the already-supported
-- datasource provenance kind. This changes no authorization or storage path.
ALTER TABLE gb_artifact_sources
  DROP CONSTRAINT IF EXISTS gb_artifact_sources_source_kind_check;

ALTER TABLE gb_artifact_sources
  ADD CONSTRAINT gb_artifact_sources_source_kind_check
  CHECK (source_kind IN ('upload', 'url', 'arxiv', 'legacy-paper', 'datasource'));

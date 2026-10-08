-- Runs once when the PostgreSQL container is first created.
-- pgvector and pg_trgm are required by the HAM schema.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

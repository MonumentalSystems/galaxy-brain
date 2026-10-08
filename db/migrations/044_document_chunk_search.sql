-- galaxy-migration: concurrent-index-v1 {"accessMethod":"gin","expression":"to_tsvector('simple'::regconfig, text_content)","index":"public.idx_gb_document_chunks_v1_fts_simple","predicate":"identity_version = 'gb.document-chunk.v1'::text","table":"public.gb_document_chunks"}
CREATE INDEX CONCURRENTLY idx_gb_document_chunks_v1_fts_simple
  ON public.gb_document_chunks
  USING GIN (to_tsvector('simple'::regconfig, text_content))
  WHERE identity_version = 'gb.document-chunk.v1'::text;

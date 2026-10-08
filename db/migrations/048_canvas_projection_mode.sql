-- Distinguish ambient workspace projections from explicitly curated canvases.
-- Existing canvases retain the current ambient behavior.

ALTER TABLE gb_canvases
  ADD COLUMN projection_mode TEXT NOT NULL DEFAULT 'ambient',
  ADD CONSTRAINT gb_canvases_projection_mode_check
    CHECK (projection_mode IN ('ambient', 'curated'));

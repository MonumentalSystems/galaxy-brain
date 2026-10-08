-- Persist bounded, presentation-only Atlas frames on the canvas aggregate.
-- Frames carry no object reference, semantic relation, or hydration authority.

ALTER TABLE gb_canvases
  ADD COLUMN frames_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT gb_canvases_frames_json_check CHECK (
    jsonb_typeof(frames_json) = 'array'
    AND jsonb_array_length(frames_json) <= 100
    AND octet_length(frames_json::text) <= 262144
  );

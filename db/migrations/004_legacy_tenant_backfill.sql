ALTER TABLE gb_experiments ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE gb_experiments SET user_id = 'legacy' WHERE user_id IS NULL;
ALTER TABLE gb_experiments ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gb_experiments_user_id ON gb_experiments(user_id);

ALTER TABLE gb_hypotheses ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE gb_hypotheses SET user_id = 'legacy' WHERE user_id IS NULL;
ALTER TABLE gb_hypotheses ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gb_hypotheses_user_id ON gb_hypotheses(user_id);

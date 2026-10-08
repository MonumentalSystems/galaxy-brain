-- Fail closed until a later migration replaces this named guard with the exact
-- accepted-baseline activation path. This insert-only trigger leaves existing
-- workspaces and the update guard from migration 025 unchanged.

CREATE OR REPLACE FUNCTION gb_reject_unactivated_proof_workspace_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof workspace activation requires an accepted proof baseline';
END;
$$;

CREATE TRIGGER gb_proof_workspaces_activation_gate
BEFORE INSERT ON gb_proof_workspaces
FOR EACH ROW EXECUTE FUNCTION gb_reject_unactivated_proof_workspace_insert();

ALTER TABLE gb_proof_workspaces
  ENABLE ALWAYS TRIGGER gb_proof_workspaces_activation_gate;

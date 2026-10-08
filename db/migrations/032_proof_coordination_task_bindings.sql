ALTER TABLE gb_proof_work_transitions
  DROP CONSTRAINT gb_proof_work_transitions_transition_type_check;

ALTER TABLE gb_proof_work_transitions
  ADD CONSTRAINT gb_proof_work_transitions_transition_type_check CHECK (
    transition_type IN (
      'claim.acquire', 'claim.release', 'work.set', 'proof.candidate',
      'proof.attest', 'proof.verify', 'proof.reject', 'proof.supersede',
      'proof.override', 'external.set', 'coordination.task.bind'
    )
  );

CREATE OR REPLACE FUNCTION gb_validate_coordination_task_binding_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_binding JSONB;
  next_binding JSONB;
  expected_count INTEGER;
BEGIN
  IF NEW.transition_type <> 'coordination.task.bind' THEN
    RETURN NEW;
  END IF;
  IF NEW.prior_state IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coordination task binding requires an explicit prior state';
  END IF;

  prior_binding := NEW.prior_state #> '{external,hyades_task_binding}';
  next_binding := NEW.next_state #> '{external,hyades_task_binding}';
  IF next_binding IS DISTINCT FROM NEW.transition #> '{payload,binding}' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coordination task binding provenance must equal the transition payload';
  END IF;
  IF (NEW.prior_state #> '{work,status}') IS DISTINCT FROM (NEW.next_state #> '{work,status}')
     OR (NEW.prior_state #> '{work,claim}') IS DISTINCT FROM (NEW.next_state #> '{work,claim}')
     OR (NEW.prior_state #> '{work,hyades}') IS DISTINCT FROM (NEW.next_state #> '{work,hyades}')
     OR (NEW.prior_state #> '{work,blocker}') IS DISTINCT FROM (NEW.next_state #> '{work,blocker}')
     OR (NEW.prior_state #> '{proof}') IS DISTINCT FROM (NEW.next_state #> '{proof}')
     OR ((NEW.prior_state #> '{external}') - 'hyades_task_binding')
        IS DISTINCT FROM ((NEW.next_state #> '{external}') - 'hyades_task_binding') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coordination task binding may not mutate work lifecycle, proof, or unrelated external state';
  END IF;
  IF NEW.next_state #>> '{work,task_id}' IS DISTINCT FROM next_binding ->> 'task_id' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coordination task binding task_id must equal its provenance';
  END IF;

  expected_count := COALESCE((NEW.prior_state #>> '{work,linked_task_count}')::INTEGER, 0)
    + CASE
        WHEN COALESCE(NEW.prior_state #>> '{work,task_id}', '') = next_binding ->> 'task_id' THEN 0
        ELSE 1
      END;
  IF (NEW.next_state #>> '{work,linked_task_count}')::INTEGER <> expected_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coordination task binding linked_task_count is not monotonic';
  END IF;
  IF prior_binding IS NOT NULL
     AND (next_binding ->> 'dispatch_sequence')::BIGINT
         <= (prior_binding ->> 'dispatch_sequence')::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'persisted coordination task binding dispatch_sequence must increase';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_coordination_task_binding_guard
BEFORE INSERT ON gb_proof_work_transitions
FOR EACH ROW EXECUTE FUNCTION gb_validate_coordination_task_binding_transition();

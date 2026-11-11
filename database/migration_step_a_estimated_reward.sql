-- Additive migration for étape A corrections (estimated vs definitive amount).
-- Safe on existing data: does not DROP or truncate.

ALTER TABLE declarations
  ADD COLUMN IF NOT EXISTS estimated_reward_amount NUMERIC(30,0);

COMMENT ON COLUMN declarations.estimated_reward_amount IS
  'Informative ECO wei estimate computed at declaration creation';
COMMENT ON COLUMN declarations.reward_amount IS
  'Definitive ECO wei amount persisted at ADMIN validate; NULL until then; required for retry';

-- Optional backfill: copy legacy informative values into estimated when estimated is null
-- and the row was never validated (still PENDING/REJECTED without definitive intent).
UPDATE declarations
SET estimated_reward_amount = reward_amount
WHERE estimated_reward_amount IS NULL
  AND reward_amount IS NOT NULL
  AND status IN ('PENDING', 'REJECTED');

-- Rows that never completed validate should not treat creation estimate as definitive.
UPDATE declarations
SET reward_amount = NULL
WHERE status IN ('PENDING', 'REJECTED')
  AND estimated_reward_amount IS NOT NULL
  AND reward_amount IS NOT NULL
  AND estimated_reward_amount = reward_amount
  AND processed_at IS NULL
  AND tx_hash IS NULL;

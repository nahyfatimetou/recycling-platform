-- Apply on existing databases created before étape A.
-- Fresh installs can use schema.sql only.

CREATE TABLE IF NOT EXISTS reward_amount_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES declarations(id) ON DELETE RESTRICT,
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_amount NUMERIC(30,0),
  new_amount NUMERIC(30,0) NOT NULL,
  justification TEXT NOT NULL CHECK (char_length(trim(justification)) >= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_overrides_declaration_created
  ON reward_amount_overrides(declaration_id, created_at DESC);

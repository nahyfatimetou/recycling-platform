CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE declaration_status AS ENUM ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'USER',
  wallet_address VARCHAR(42),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  material VARCHAR(80) NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  description TEXT,
  status declaration_status NOT NULL DEFAULT 'PENDING',
  wallet_address VARCHAR(42),
  estimated_reward_amount NUMERIC(30,0), -- informative estimate at creation (wei)
  reward_amount NUMERIC(30,0), -- definitive amount set at ADMIN validate only (wei)
  declaration_key CHAR(66) UNIQUE NOT NULL, -- 0x + bytes32
  tx_hash VARCHAR(80),
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_declarations_user_created ON declarations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_declarations_status_created ON declarations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_declarations_tx_hash ON declarations(tx_hash);

CREATE TABLE IF NOT EXISTS reward_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL UNIQUE REFERENCES declarations(id),
  tx_hash VARCHAR(80) NOT NULL,
  wallet_address VARCHAR(42) NOT NULL,
  amount NUMERIC(30,0) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit trail for ADMIN reward overrides (justification required by API).
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

-- ─── Weekly Eco Challenge ───────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE challenge_task_status AS ENUM (
    'TODO', 'IN_PROGRESS', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE challenge_bonus_status AS ENUM (
    'NONE', 'PENDING', 'PROCESSING', 'GRANTED', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS weekly_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  bonus_reward_wei NUMERIC(30,0) NOT NULL DEFAULT 0 CHECK (bonus_reward_wei >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT weekly_challenges_week_order CHECK (week_end >= week_start),
  CONSTRAINT weekly_challenges_week_start_unique UNIQUE (week_start)
);

CREATE TABLE IF NOT EXISTS weekly_challenge_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  reward_wei NUMERIC(30,0) NOT NULL DEFAULT 0 CHECK (reward_wei >= 0),
  CONSTRAINT weekly_challenge_tasks_day_unique UNIQUE (challenge_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_weekly_challenge_tasks_challenge
  ON weekly_challenge_tasks(challenge_id, day_of_week);

CREATE TABLE IF NOT EXISTS user_weekly_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bonus_reward_status challenge_bonus_status NOT NULL DEFAULT 'NONE',
  bonus_reward_key CHAR(66) UNIQUE,
  bonus_reward_amount NUMERIC(30,0),
  bonus_tx_hash VARCHAR(80),
  bonus_last_error TEXT,
  badge_code VARCHAR(50),
  completed_at TIMESTAMPTZ,
  CONSTRAINT user_weekly_challenges_unique UNIQUE (user_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_weekly_challenges_user
  ON user_weekly_challenges(user_id, enrolled_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_weekly_challenges_bonus
  ON user_weekly_challenges(bonus_reward_status);

CREATE TABLE IF NOT EXISTS user_challenge_task_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES user_weekly_challenges(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES weekly_challenge_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status challenge_task_status NOT NULL DEFAULT 'TODO',
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reward_key CHAR(66) NOT NULL UNIQUE,
  reward_amount NUMERIC(30,0),
  points_earned NUMERIC(30,0) NOT NULL DEFAULT 0,
  tx_hash VARCHAR(80),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_challenge_task_progress_unique UNIQUE (enrollment_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_user_challenge_task_progress_status
  ON user_challenge_task_progress(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_challenge_task_progress_user
  ON user_challenge_task_progress(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS challenge_reward_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('TASK', 'BONUS')),
  progress_id UUID REFERENCES user_challenge_task_progress(id) ON DELETE SET NULL,
  enrollment_id UUID REFERENCES user_weekly_challenges(id) ON DELETE SET NULL,
  reward_key CHAR(66) NOT NULL UNIQUE,
  tx_hash VARCHAR(80) NOT NULL,
  wallet_address VARCHAR(42) NOT NULL,
  amount NUMERIC(30,0) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_code VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  challenge_id UUID REFERENCES weekly_challenges(id) ON DELETE SET NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_badges_unique UNIQUE (user_id, badge_code, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id, earned_at DESC);

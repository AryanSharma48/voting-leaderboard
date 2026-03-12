-- ============================================================
-- MIGRATION: Voting System v2 - Production Safety Updates
-- ============================================================
-- Run this migration on existing databases to add:
-- 1. voting_session column for vote reset support
-- 2. Unique constraint for idempotent voting
-- 3. system_config table for voting toggle
-- 4. leaderboard materialized table
-- ============================================================

-- 1. Add system_config table if not exists
CREATE TABLE IF NOT EXISTS public.system_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT 'true'::jsonb,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Insert default voting_active config
INSERT INTO public.system_config (key, value) 
VALUES ('voting_active', 'true')
ON CONFLICT (key) DO NOTHING;

-- Enable realtime for system_config
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'system_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.system_config;
  END IF;
END $$;

-- 2. Add voting_session column to votes table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'votes' AND column_name = 'voting_session'
  ) THEN
    ALTER TABLE public.votes ADD COLUMN voting_session text NOT NULL DEFAULT '1';
  END IF;
END $$;

-- 3. Change user_id to text type if it's UUID (Google IDs are strings)
-- Note: This requires data migration if you have existing votes
-- Uncomment if needed:
-- ALTER TABLE public.votes ALTER COLUMN user_id TYPE text;

-- 4. Drop old unique constraint and add new session-based one
DO $$
BEGIN
  -- Drop old constraint if exists
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'votes_user_id_key' AND table_name = 'votes'
  ) THEN
    ALTER TABLE public.votes DROP CONSTRAINT votes_user_id_key;
  END IF;
  
  -- Add new session-based constraint if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'votes_user_session_unique' AND table_name = 'votes'
  ) THEN
    ALTER TABLE public.votes 
    ADD CONSTRAINT votes_user_session_unique UNIQUE (user_id, voting_session);
  END IF;
END $$;

-- 5. Add indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_votes_session ON public.votes(voting_session);
CREATE INDEX IF NOT EXISTS idx_votes_user_session ON public.votes(user_id, voting_session);

-- 6. Create leaderboard table for materialized view
CREATE TABLE IF NOT EXISTS public.leaderboard (
  team_id uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
  name text,
  vote_count integer DEFAULT 0,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Enable RLS on system_config
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

-- 8. Create RLS policies for system_config
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'System config readable by all.'
  ) THEN
    CREATE POLICY "System config readable by all." ON public.system_config
      FOR SELECT USING (true);
  END IF;
END $$;

-- 9. Create or replace the live leaderboard view
CREATE OR REPLACE VIEW public.leaderboard_live AS
SELECT 
  t.id AS team_id,
  t.name,
  COUNT(v.id) AS vote_count
FROM public.teams t
LEFT JOIN public.votes v ON t.id = v.team_id
GROUP BY t.id, t.name
ORDER BY vote_count DESC, t.name ASC;

-- 10. Grant necessary permissions
GRANT SELECT ON public.system_config TO anon, authenticated;
GRANT SELECT ON public.leaderboard TO anon, authenticated;
GRANT SELECT ON public.leaderboard_live TO anon, authenticated;

-- ============================================================
-- Migration Complete
-- ============================================================

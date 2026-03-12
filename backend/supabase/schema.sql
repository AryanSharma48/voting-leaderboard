-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Table: system_config (for voting toggle and other settings)
create table if not exists public.system_config (
  key text primary key,
  value jsonb not null default 'true'::jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Insert default voting_active config
insert into public.system_config (key, value) values ('voting_active', 'true')
on conflict (key) do nothing;

-- Enable realtime for system_config
alter publication supabase_realtime add table public.system_config;

-- Table: teams
create table public.teams (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  image_url text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table: votes
-- IMPORTANT: Unique constraint on (user_id, voting_session) ensures one vote per user per session
create table public.votes (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null, -- Google sub ID (string, not UUID)
  team_id uuid not null references public.teams(id) on delete cascade,
  voting_session text not null default '1', -- Session identifier for vote resets
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  
  -- CRITICAL: Ensure one vote per user per voting session at the DB level
  constraint votes_user_session_unique unique (user_id, voting_session)
);

-- Index for efficient queries by session
create index if not exists idx_votes_session on public.votes(voting_session);
create index if not exists idx_votes_user_session on public.votes(user_id, voting_session);

-- Enable Realtime for the 'votes' table so the Admin view can listen to it
alter publication supabase_realtime add table public.votes;
alter publication supabase_realtime add table public.teams;

-- RLS (Row Level Security) Policies
alter table public.teams enable row level security;
alter table public.votes enable row level security;
alter table public.system_config enable row level security;

-- Teams: Anyone can read (for the voter app list)
create policy "Teams are viewable by everyone." on public.teams
  for select using (true);

-- Votes: 
-- Backend uses Service Role key which bypasses RLS
-- Block direct client writes
create policy "Direct client inserts blocked. Must use API." on public.votes
  for insert with check (false);

-- Votes viewable for admin dashboard
create policy "Votes viewable by admins." on public.votes
  for select using (true);

-- System config: readable by everyone, writable only by service role (bypasses RLS)
create policy "System config readable by all." on public.system_config
  for select using (true);

create policy "System config writable via service role only." on public.system_config
  for all using (false);

-- Table: leaderboard (materialized by cron, not a view for performance)
create table if not exists public.leaderboard (
  team_id uuid primary key references public.teams(id) on delete cascade,
  name text,
  vote_count integer default 0,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- View: Real-time leaderboard calculation (use for accuracy checks)
create or replace view public.leaderboard_live as
select 
  t.id as team_id,
  t.name,
  count(v.id) as vote_count
from public.teams t
left join public.votes v on t.id = v.team_id
group by t.id, t.name
order by vote_count desc, t.name asc;

-- Function to safely insert vote with ON CONFLICT handling
-- This can be called from backend if needed
create or replace function public.insert_vote(
  p_user_id text,
  p_team_id uuid,
  p_voting_session text default '1'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_result jsonb;
begin
  insert into public.votes (user_id, team_id, voting_session)
  values (p_user_id, p_team_id, p_voting_session)
  on conflict (user_id, voting_session) do nothing;
  
  if found then
    v_result := jsonb_build_object('success', true, 'message', 'Vote recorded');
  else
    v_result := jsonb_build_object('success', false, 'message', 'Already voted');
  end if;
  
  return v_result;
end;
$$;

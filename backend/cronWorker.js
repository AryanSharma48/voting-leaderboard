import cron from 'node-cron';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

console.log('⏳ Initializing Vote Sync Cron Worker...');

/**
 * Sync Redis leaderboard counts to Supabase leaderboard table
 * This provides a backup materialized view for the admin dashboard
 */
cron.schedule('*/60 * * * * *', async () => {
  console.log('🔄 [CRON] Starting Redis -> Supabase Vote Sync...');
  try {
    // 1. Fetch current counts from Redis Hash
    const liveCounts = await redis.hgetall('live_leaderboard');
    if (!liveCounts || Object.keys(liveCounts).length === 0) {
      console.log('🔄 [CRON] No votes found in Redis. Skipping sync.');
      return;
    }

    // 2. Get team names for the leaderboard
    const { data: teams, error: teamsError } = await supabase
      .from('teams')
      .select('id, name');

    if (teamsError) {
      console.error('❌ [CRON] Failed to fetch teams:', teamsError.message);
      return;
    }

    const teamNameMap = new Map(teams?.map(t => [t.id, t.name]) || []);

    // 3. Prepare bulk update for Supabase Leaderboard
    const updates = Object.keys(liveCounts).map((teamId) => {
      const val = liveCounts[teamId];
      return {
        team_id: teamId,
        name: teamNameMap.get(teamId) || 'Unknown Team',
        vote_count: parseInt(String(val), 10),
        updated_at: new Date().toISOString()
      };
    });

    // 4. Perform Upsert to Postgres leaderboard table
    const { error } = await supabase
      .from('leaderboard')
      .upsert(updates, { onConflict: 'team_id' });

    if (error) {
      console.error('❌ [CRON] Failed to sync votes to Supabase:', error.message);
    } else {
      console.log(`✅ [CRON] Successfully synced ${updates.length} teams to Supabase.`);
    }

  } catch (error) {
    console.error('❌ [CRON] Unexpected Error during sync:', error.message);
  }
});

/**
 * Health check - verify Redis connection every 5 minutes
 */
cron.schedule('*/5 * * * *', async () => {
  try {
    await redis.ping();
    console.log('💓 [CRON] Redis health check: OK');
  } catch (error) {
    console.error('💔 [CRON] Redis health check failed:', error.message);
  }
});

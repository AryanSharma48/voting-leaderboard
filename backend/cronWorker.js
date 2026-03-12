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

// Run every 60 seconds
cron.schedule('*/60 * * * * *', async () => {
  console.log('🔄 [CRON] Starting Redis -> Supabase Vote Sync...');
  try {
    // 1. Fetch current counts from Redis Hash
    const liveCounts = await redis.hgetall('live_leaderboard');
    if (!liveCounts || Object.keys(liveCounts).length === 0) {
      console.log('🔄 [CRON] No votes found in Redis. Skipping sync.');
      return;
    }

    // 2. Prepare bulk update for Supabase Leaderboard
    const updates = Object.keys(liveCounts).map((teamId) => {
      let val = liveCounts[teamId];
      // hgetall returns strings, parse them
      return {
        team_id: teamId,
        vote_count: parseInt(val, 10),
      };
    });

    // 3. Perform Upsert to Postgres
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

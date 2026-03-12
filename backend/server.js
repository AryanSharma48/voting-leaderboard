import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import { OAuth2Client } from 'google-auth-library';
import './cronWorker.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

// Admin emails allowlist - only these emails can access admin endpoints
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Redis lock TTL in seconds (10 minutes)
const VOTE_LOCK_TTL = 600;

// ============================================================
// MIDDLEWARE
// ============================================================

// Secure CORS - only allow specific frontend origin
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Trust proxy for rate limiting behind Render/load balancers
app.set('trust proxy', 1);

// ============================================================
// RATE LIMITERS
// ============================================================

const voteRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many vote attempts. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const voteStatusRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const liveCountsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many admin requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// INITIALIZE SERVICES
// ============================================================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Verify Google ID token and extract user info
 */
async function verifyGoogleToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing or invalid authorization token', status: 401 };
  }

  const idToken = authHeader.split(' ')[1];

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      return { error: 'Invalid token payload', status: 401 };
    }
    return {
      user: {
        id: payload.sub,
        email: payload.email?.toLowerCase(),
        name: payload.name,
      }
    };
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    return { error: 'Invalid or expired Google token. Please sign in again.', status: 401 };
  }
}

/**
 * Verify admin authentication - requires valid Google token AND email in allowlist
 */
async function verifyAdminAuth(req) {
  const auth = await verifyGoogleToken(req);
  if (auth.error) return auth;

  const email = auth.user.email?.toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return { error: 'Unauthorized: Admin access required', status: 403 };
  }

  return auth;
}

/**
 * Get current voting session ID from Redis
 */
async function getCurrentSession() {
  const session = await redis.get('current_voting_session');
  return session || '1';
}

/**
 * Check if voting is currently active
 */
async function isVotingActive() {
  const active = await redis.get('voting_active');
  // Default to true if not set
  return active !== 'false';
}

/**
 * Set voting active state in Redis
 */
async function setVotingActive(active) {
  await redis.set('voting_active', active ? 'true' : 'false');
}

/**
 * Rebuild Redis leaderboard from Postgres (source of truth)
 */
async function rebuildLeaderboardFromDatabase() {
  console.log('🔄 Rebuilding Redis leaderboard from Postgres...');
  
  try {
    // Get current session
    let session = await redis.get('current_voting_session');
    if (!session) {
      session = '1';
      await redis.set('current_voting_session', session);
    }

    // Query vote counts from Postgres
    const { data: voteCounts, error } = await supabase
      .from('votes')
      .select('team_id')
      .eq('voting_session', session);

    if (error) {
      console.error('Failed to query votes from Postgres:', error);
      return false;
    }

    // Clear existing leaderboard
    await redis.del('live_leaderboard');

    if (!voteCounts || voteCounts.length === 0) {
      console.log('✅ No votes found for current session. Leaderboard is empty.');
      return true;
    }

    // Count votes per team
    const counts = {};
    for (const vote of voteCounts) {
      counts[vote.team_id] = (counts[vote.team_id] || 0) + 1;
    }

    // Rebuild leaderboard hash
    for (const [teamId, count] of Object.entries(counts)) {
      await redis.hset('live_leaderboard', { [teamId]: count });
    }

    // Rebuild vote locks for users who already voted
    const { data: userVotes, error: userVotesError } = await supabase
      .from('votes')
      .select('user_id, team_id')
      .eq('voting_session', session);

    if (!userVotesError && userVotes) {
      for (const vote of userVotes) {
        const lockKey = `vote:${session}:${vote.user_id}`;
        await redis.set(lockKey, vote.team_id, { ex: VOTE_LOCK_TTL });
      }
    }

    console.log(`✅ Rebuilt leaderboard: ${Object.keys(counts).length} teams, ${voteCounts.length} total votes`);
    return true;
  } catch (err) {
    console.error('Failed to rebuild leaderboard:', err);
    return false;
  }
}

/**
 * Clear all Redis vote locks for current session
 */
async function clearRedisVoteLocks(session) {
  let cursor = 0;
  let totalDeleted = 0;

  do {
    const result = await redis.scan(cursor, { match: `vote:${session}:*`, count: 500 });
    const nextCursor = result[0];
    const keys = result[1];
    
    cursor = Number(nextCursor);
    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
  } while (cursor !== 0);

  return totalDeleted;
}

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================

/**
 * GET /api/vote-status
 * Check if current user has already voted in this session
 */
app.get('/api/vote-status', voteStatusRateLimiter, async (req, res) => {
  try {
    const auth = await verifyGoogleToken(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const session = await getCurrentSession();
    const lockKey = `vote:${session}:${auth.user.id}`;
    const existingVote = await redis.get(lockKey);

    // Also get voting active state
    const votingActive = await isVotingActive();

    return res.status(200).json({ 
      hasVoted: !!existingVote,
      votingActive,
      session
    });
  } catch (error) {
    console.error('Vote status check error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/live-counts
 * Get current leaderboard counts (public endpoint)
 */
app.get('/api/live-counts', liveCountsRateLimiter, async (req, res) => {
  try {
    const [counts, session, votingActive] = await Promise.all([
      redis.hgetall('live_leaderboard'),
      getCurrentSession(),
      isVotingActive()
    ]);

    return res.status(200).json({
      counts: counts || {},
      current_voting_session: session,
      voting_active: votingActive
    });
  } catch (error) {
    console.error('Fetch live counts error:', error);
    return res.status(500).json({ error: 'Failed to fetch live counts' });
  }
});

/**
 * POST /api/vote
 * THE SINGLE AUTHORITATIVE VOTE ENDPOINT
 * Implements idempotent, error-safe voting with proper locking
 */
app.post('/api/vote', voteRateLimiter, async (req, res) => {
  let lockAcquired = false;
  let lockKey = null;

  try {
    // Step 1: Verify Google token
    const auth = await verifyGoogleToken(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const userId = auth.user.id;
    const { teamId } = req.body;

    if (!teamId) {
      return res.status(400).json({ error: 'Missing teamId' });
    }

    // Step 2: Check if voting is active
    const votingActive = await isVotingActive();
    if (!votingActive) {
      return res.status(403).json({ error: 'Voting is currently paused by the administrator.' });
    }

    // Step 3: Get current session
    const session = await getCurrentSession();
    lockKey = `vote:${session}:${userId}`;

    // Step 4: Check for existing vote (idempotency check)
    const existingVote = await redis.get(lockKey);
    if (existingVote) {
      // Idempotent: return success if same team, error if different
      if (existingVote === teamId) {
        return res.status(200).json({ message: 'Vote already recorded', idempotent: true });
      } else {
        return res.status(400).json({ error: 'Already voted for a different team' });
      }
    }

    // Step 5: Acquire Redis lock with TTL
    // SET key value NX EX ttl - atomic lock acquisition
    const acquired = await redis.set(lockKey, teamId, { nx: true, ex: VOTE_LOCK_TTL });
    
    if (!acquired) {
      // Race condition: another request acquired the lock
      return res.status(400).json({ error: 'Already Voted' });
    }
    lockAcquired = true;

    // Step 6: Insert into PostgreSQL with ON CONFLICT DO NOTHING
    const { data: insertData, error: insertError } = await supabase
      .from('votes')
      .insert({ 
        user_id: userId, 
        team_id: teamId,
        voting_session: session
      })
      .select()
      .single();

    if (insertError) {
      // Check if it's a unique constraint violation (user already voted in DB)
      if (insertError.code === '23505') {
        // Vote already exists in DB - this is fine, update Redis to match
        console.log('Vote already exists in Postgres for user:', userId);
        return res.status(200).json({ message: 'Vote already recorded', idempotent: true });
      }

      console.error('Database insert failed:', insertError);
      // Rollback: release Redis lock
      await redis.del(lockKey);
      lockAcquired = false;
      return res.status(503).json({ error: 'Service temporarily unavailable. Try again.' });
    }

    // Step 7: Increment the live leaderboard cache
    try {
      await redis.hincrby('live_leaderboard', teamId, 1);
    } catch (redisErr) {
      console.error('Failed to increment live leaderboard:', redisErr);
      // Non-critical: vote is recorded, leaderboard will sync eventually
    }

    return res.status(200).json({ message: 'Vote Recorded', session });

  } catch (error) {
    console.error('Vote processing error:', error);
    
    // Rollback: release Redis lock if acquired
    if (lockAcquired && lockKey) {
      try {
        await redis.del(lockKey);
      } catch (rollbackErr) {
        console.error('Failed to rollback Redis lock:', rollbackErr);
      }
    }

    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================
// ADMIN ENDPOINTS (Require authentication + admin email)
// ============================================================

/**
 * POST /api/admin/toggle-voting
 * Toggle voting on/off
 */
app.post('/api/admin/toggle-voting', adminRateLimiter, async (req, res) => {
  try {
    const auth = await verifyAdminAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Missing or invalid "enabled" boolean' });
    }

    await setVotingActive(enabled);

    // Also update Supabase for realtime sync
    await supabase
      .from('system_config')
      .upsert({ key: 'voting_active', value: enabled }, { onConflict: 'key' });

    console.log(`🔒 Voting ${enabled ? 'ENABLED' : 'DISABLED'} by admin: ${auth.user.email}`);
    return res.status(200).json({ message: `Voting ${enabled ? 'enabled' : 'disabled'}`, enabled });

  } catch (error) {
    console.error('Toggle voting error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * DELETE /api/admin/votes
 * Safe vote reset with atomic sequence
 */
app.delete('/api/admin/votes', adminRateLimiter, async (req, res) => {
  try {
    // Step 0: Verify admin authentication
    const auth = await verifyAdminAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    console.log(`⚠️ Vote reset initiated by admin: ${auth.user.email}`);

    // Step 1: Pause voting
    await setVotingActive(false);
    await supabase
      .from('system_config')
      .upsert({ key: 'voting_active', value: false }, { onConflict: 'key' });
    console.log('Step 1: Voting paused');

    // Step 2: Wait for in-flight requests to complete
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('Step 2: Waited 2 seconds');

    // Step 3: Get current session before clearing
    const oldSession = await getCurrentSession();

    // Step 4: Clear Postgres votes for current session
    const { error: deleteError } = await supabase
      .from('votes')
      .delete()
      .eq('voting_session', oldSession);

    if (deleteError) {
      console.error('Failed to clear votes table:', deleteError);
      // Re-enable voting before returning error
      await setVotingActive(true);
      return res.status(500).json({ error: 'Failed to clear votes from database.' });
    }
    console.log('Step 3: Postgres votes cleared');

    // Step 5: Clear Redis vote locks
    const deletedLocks = await clearRedisVoteLocks(oldSession);
    console.log(`Step 4: Cleared ${deletedLocks} Redis vote locks`);

    // Step 6: Reset leaderboard
    await redis.del('live_leaderboard');
    console.log('Step 5: Leaderboard reset');

    // Step 7: Increment voting session
    const newSession = Date.now().toString();
    await redis.set('current_voting_session', newSession);
    console.log(`Step 6: New session: ${newSession}`);

    // Step 8: Resume voting
    await setVotingActive(true);
    await supabase
      .from('system_config')
      .upsert({ key: 'voting_active', value: true }, { onConflict: 'key' });
    console.log('Step 7: Voting resumed');

    return res.status(200).json({ 
      message: 'All votes cleared successfully.',
      oldSession,
      newSession
    });

  } catch (error) {
    console.error('Clear votes error:', error);
    // Try to re-enable voting on error
    try {
      await setVotingActive(true);
    } catch (e) {
      console.error('Failed to re-enable voting:', e);
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/admin/status
 * Get admin system status
 */
app.get('/api/admin/status', adminRateLimiter, async (req, res) => {
  try {
    const auth = await verifyAdminAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const [session, votingActive, leaderboard] = await Promise.all([
      getCurrentSession(),
      isVotingActive(),
      redis.hgetall('live_leaderboard')
    ]);

    // Get total votes from Postgres
    const { count: totalVotes } = await supabase
      .from('votes')
      .select('*', { count: 'exact', head: true })
      .eq('voting_session', session);

    return res.status(200).json({
      session,
      votingActive,
      leaderboard: leaderboard || {},
      totalVotes: totalVotes || 0,
      adminEmail: auth.user.email
    });

  } catch (error) {
    console.error('Admin status error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================
// LEGACY ENDPOINTS (Redirect to new admin endpoints)
// ============================================================

// Redirect old DELETE /api/votes to new authenticated endpoint
app.delete('/api/votes', (req, res) => {
  res.status(410).json({ 
    error: 'This endpoint has been moved. Use DELETE /api/admin/votes with admin authentication.' 
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', async (req, res) => {
  try {
    // Quick Redis ping
    await redis.ping();
    
    res.status(200).json({ 
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'degraded',
      error: 'Redis connection issue'
    });
  }
});

// ============================================================
// SERVER STARTUP
// ============================================================

async function startServer() {
  try {
    // Initialize voting state if not set
    const votingActive = await redis.get('voting_active');
    if (votingActive === null) {
      await redis.set('voting_active', 'true');
    }

    // Initialize session if not set
    const session = await redis.get('current_voting_session');
    if (!session) {
      await redis.set('current_voting_session', '1');
    }

    // Rebuild leaderboard from Postgres on startup
    await rebuildLeaderboardFromDatabase();

    app.listen(PORT, () => {
      console.log(`🚀 Voting Backend running on port ${PORT}`);
      console.log(`📋 Admin emails: ${ADMIN_EMAILS.length > 0 ? ADMIN_EMAILS.join(', ') : 'NONE CONFIGURED'}`);
      console.log(`🔗 CORS origin: ${process.env.FRONTEND_URL || 'NOT SET'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
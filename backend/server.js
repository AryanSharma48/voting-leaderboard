import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import { OAuth2Client } from 'google-auth-library';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Initialize Redis (Upstash REST)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

// Initialize Supabase Admin Client (Service Role for DB writes bypassing RLS)
const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// Initialize Google OAuth2 Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper: Verify Google ID token and extract user info
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
        id: payload.sub,           // Google's unique user ID
        email: payload.email,
        name: payload.name,
      }
    };
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    return { error: 'Invalid or expired Google token. Please sign in again.', status: 401 };
  }
}

// Check if a user has already voted
app.get('/api/vote-status', async (req, res) => {
  try {
    const auth = await verifyGoogleToken(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const lockKey = `voted:${auth.user.id}`;
    const hasVoted = await redis.get(lockKey);

    return res.status(200).json({ hasVoted: !!hasVoted });
  } catch (error) {
    console.error('Vote status check error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// The Core Vote Endpoint
app.post('/api/vote', async (req, res) => {
  try {
    const auth = await verifyGoogleToken(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const userId = auth.user.id;
    const { teamId } = req.body;

    if (!teamId) {
      return res.status(400).json({ error: 'Missing teamId' });
    }

    // Atomic lock: SETNX guarantees one vote per user
    const lockKey = `voted:${userId}`;
    const acquired = await redis.setnx(lockKey, 'true');

    if (acquired === 0) {
      return res.status(400).json({ error: 'Already Voted' });
    }

    // Insert into PostgreSQL via Supabase
    const { error: insertError } = await supabase
      .from('votes')
      .insert({ user_id: userId, team_id: teamId });

    if (insertError) {
      console.error('Database insert failed:', insertError);
      await redis.del(lockKey);
      return res.status(503).json({ error: 'Service temporarily unavailable. Try again.' });
    }

    return res.status(200).json({ message: 'Vote Recorded' });
  } catch (error) {
    console.error('Vote processing error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Clear All Votes
app.delete('/api/votes', async (req, res) => {
  try {
    const { error: deleteError } = await supabase
      .from('votes')
      .delete()
      .gte('created_at', '1970-01-01');

    if (deleteError) {
      console.error('Failed to clear votes table:', deleteError);
      return res.status(500).json({ error: 'Failed to clear votes from database.' });
    }

    try {
      const keys = await redis.keys('voted:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (redisErr) {
      console.warn('Redis lock cleanup failed (non-critical):', redisErr);
    }

    return res.status(200).json({ message: 'All votes cleared successfully.' });
  } catch (error) {
    console.error('Clear votes error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Voting Backend running on port ${PORT}`);
});

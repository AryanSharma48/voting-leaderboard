import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';
import { OAuth2Client } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

// Initialize Redis Client
const redis = new Redis({
  url: process.env.VITE_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.VITE_UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

// We still need Supabase here ONLY for checking the master 'voting_active' switch. 
// Standard query is fast, but we could also cache this in Redis.
const supabase = createClient(
  process.env.VITE_PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || '',
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
);

const googleClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);

// Verify Google ID Token
async function verifyGoogleToken(req: VercelRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing or invalid authorization token', status: 401 };
  }

  const idToken = authHeader.split(' ')[1];

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      return { error: 'Invalid token payload', status: 401 };
    }
    return {
      user: {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
      }
    };
  } catch (err: any) {
    console.error('Google token verification failed:', err.message);
    return { error: 'Invalid or expired Google token. Please sign in again.', status: 401 };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const auth = await verifyGoogleToken(req);
    if (auth.error) {
      return res.status(auth.status || 401).json({ error: auth.error });
    }

    const userId = auth.user?.id;
    const { teamId } = req.body;

    if (!teamId || !userId) {
      return res.status(400).json({ error: 'Missing teamId or userId' });
    }

    // Check Master Switch (if applicable)
    // To save DB hits, we might cache this in Redis, but we'll do one DB read for now, 
    // or even skip if Redis handles the load better. Let's do Redis caching:
    let isVotingActive = await redis.get<boolean>('config:voting_active');
    
    if (isVotingActive === null) {
      const { data: config } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'voting_active')
        .single();
    
      isVotingActive = config?.value !== false;
      await redis.set('config:voting_active', isVotingActive, { ex: 5 }); // Cache for 5s
    }

    if (!isVotingActive) {
      return res.status(403).json({ error: 'Voting is currently paused by the administrator.' });
    }

    // Atomic Lock: SETNX for one vote per user
    const lockKey = `voted:${userId}`;
    const acquired = await redis.setnx(lockKey, 'true');

    if (acquired === 0) {
      return res.status(400).json({ error: 'Already Voted' });
    }

    // Pipeline to execute multiple commands for speed
    const pipeline = redis.pipeline();
    // Increment the specific team's vote in a hash to keep all totals organized
    pipeline.hincrby('live_leaderboard', teamId, 1);
    // Add the raw vote to a list for the cron job to process correctly without duplicates if needed
    // Or better, just let the cron job sync the entire `live_leaderboard` hash
    await pipeline.exec();

    return res.status(200).json({ message: 'Vote Recorded' });
  } catch (error: any) {
    console.error('Vote processing error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

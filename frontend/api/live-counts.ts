import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

// Initialize Redis Client (read-only operations)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

// Allowed origin for CORS
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || '*';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Secure CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
  // Prevent caching of live data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Fetch all required data in parallel for efficiency
    const [leaderboard, currentSession, votingActive] = await Promise.all([
      redis.hgetall('live_leaderboard'),
      redis.get('current_voting_session'),
      redis.get('voting_active')
    ]);
    
    return res.status(200).json({ 
      counts: leaderboard || {},
      current_voting_session: currentSession || '1',
      voting_active: votingActive !== 'false' // Default to true if not set
    });
  } catch (error: any) {
    console.error('Fetch live counts error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch live counts' });
  }
}

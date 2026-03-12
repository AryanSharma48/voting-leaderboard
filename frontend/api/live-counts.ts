import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

// Initialize Redis Client
const redis = new Redis({
  url: process.env.VITE_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.VITE_UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust this in production
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // We expect vote keys to follow the pattern team_votes:{teamId}
    // Alternatively, we can keep a sorted set or a hash in redis.
    // Let's assume the previous backend used a pattern, or we create a new standard here.
    // If we use individual keys: `team_votes:*`
    // Or better, a single Redis Hash mapping team_id -> count: `live_leaderboard`
    const teamsHashes = await redis.hgetall('live_leaderboard');
    
    // If the hash is empty, we return an empty object
    return res.status(200).json({ counts: teamsHashes || {} });
  } catch (error: any) {
    console.error('Fetch live counts error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch live counts' });
  }
}

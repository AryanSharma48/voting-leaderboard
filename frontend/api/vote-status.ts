import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';
import { OAuth2Client } from 'google-auth-library';

const redis = new Redis({
  url: process.env.VITE_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.VITE_UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

const googleClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);

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
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const auth = await verifyGoogleToken(req);
    if (auth.error) {
       return res.status(auth.status || 401).json({ error: auth.error });
    }

    const lockKey = `voted:${auth.user?.id}`;
    const hasVoted = await redis.get(lockKey);

    return res.status(200).json({ hasVoted: !!hasVoted });
  } catch (error: any) {
    console.error('Vote status check error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

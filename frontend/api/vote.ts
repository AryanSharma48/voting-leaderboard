import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * DISABLED: This endpoint has been removed for production safety.
 * 
 * All vote operations must go through the Express backend at:
 * POST {API_URL}/api/vote
 * 
 * This ensures:
 * 1. Proper Redis locking with TTL
 * 2. Postgres vote persistence
 * 3. Idempotent voting
 * 4. Consistent data between Redis and Postgres
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers for error response
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Return 410 Gone - this endpoint is permanently disabled
  return res.status(410).json({ 
    error: 'This endpoint has been disabled. Please use the Express backend API for voting.',
    redirect: `${process.env.VITE_API_URL || process.env.API_URL}/api/vote`
  });
}

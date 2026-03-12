import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * DISABLED: This endpoint has been moved to the Express backend.
 * 
 * Vote status should be checked via:
 * GET {API_URL}/api/vote-status
 * 
 * This ensures consistent state between vote locks and status checks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Return 410 Gone - redirect to Express backend
  return res.status(410).json({ 
    error: 'This endpoint has been moved. Please use the Express backend API.',
    redirect: `${process.env.VITE_API_URL || process.env.API_URL}/api/vote-status`
  });
}

# 🌌 Oneiros 2026 // Live Voting Application

A highly concurrent, real-time voting and leaderboard system designed to handle massive traffic bursts (1,500+ users) smoothly and securely.

Built with **React (Vite), TypeScript, Express.js, Upstash Redis, and Supabase (PostgreSQL)**.

---

## 🚀 Architecture & Tech Stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS
- **Authentication:** Google OAuth2 (Sign in with Google)
- **Backend/API:**
  - Vercel Serverless Functions for Edge-optimized, cached live data fetching (`/api/live-counts`).
  - Express.js (Deployed on Render) for core voting execution, Supabase writes, and database operations.
- **State & Caching:** Upstash Redis handles high-throughput atomic locks and maintains live leaderboard hash states.
- **Database:** Supabase (PostgreSQL) acts as the durable source of truth.
- **Data Fetching:** SWR (Stale-While-Revalidate) is used on the frontend for resilient, lightweight 3-second smart polling.

---

## ⚡ Key Features

- **Smart Polling Leaderboard:** Instead of relying on expensive, heavy WebSockets under high load, the app uses `useSWR` to poll the `/api/live-counts` Vercel edge function every 3 seconds. It fetches lightweight Redis hashes with strict `Cache-Control: no-store, max-age=0` headers.
- **"Ghost Lock" Resiliency:** Uses Redis `SETNX` (Set if Not eXists) to establish an atomic lock, physically blocking double voting endpoints at the caching layer before it even hits the database.
- **Admin Session & Control Panel:** 
  - The Admin can toggle global voting on or off instantly using Supabase Realtime subscriptions.
  - The **Clear Votes** operation executes a non-blocking Redis `SCAN` to safely batch-delete 1,500+ lock keys without freezing the cluster thread. It broadcasts a `current_voting_session` timestamp change that automatically updates `LocalStorage` and releases the disabled UI state on all voters' devices.
- **Optimistic UI:** When a user casts a vote, their UI locks instantly (via LocalStorage), while the Postgres persist and Redis `hincrby` operations execute in the background.

---

## 📁 Repository Structure

```text
├── leaderboardONO/
│   ├── backend/
│   │   ├── server.js          # Core Express app (POST /vote, DELETE /votes)
│   │   ├── cronWorker.js      # Background job syncing Postgres DB -> Redis
│   │   └── package.json
│   │
│   ├── frontend/
│   │   ├── api/               
│   │   │   ├── live-counts.ts # Vercel Serverless Route for instantaneous Redis reads
│   │   │   └── vote-status.ts # Vercel Route verifying Google OAuth tokens
│   │   │
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── VoterApp.tsx             # Main Participant Application UI
│   │   │   │   └── AdminLiveLeaderboard.tsx # Real-time Admin Dashboard
│   │   │   ├── lib/
│   │   │   │   └── supabase.ts              # Supabase Client config
│   │   │   ├── App.tsx                      # React Router configuration
│   │   │   └── main.tsx                     # Vite entry point
│   │   │
│   │   ├── package.json
│   │   └── vite.config.ts
```

---

## 🛠️ Environment Variables

### Frontend (`leaderboardONO/frontend/.env`)
```env
# Supabase
VITE_SUPABASE_URL=https://your-supabase-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key

# Backend Routes
VITE_API_URL=https://your-express-app.onrender.com

# Google Auth
VITE_GOOGLE_CLIENT_ID=your_oauth_client_id.apps.googleusercontent.com

# Redis (For Vercel Edge API Routes)
UPSTASH_REDIS_REST_URL=https://your-upstash-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
PUBLIC_SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### Backend (`leaderboardONO/backend/.env`)
```env
PORT=3000
FRONTEND_URL=https://your-vercel-frontend.vercel.app

# Database & Cache Authentication
UPSTASH_REDIS_REST_URL=https://your-upstash-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

PUBLIC_SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Google Auth Verification
GOOGLE_CLIENT_ID=your_oauth_client_id.apps.googleusercontent.com
```

---

## 🚀 Running Locally

1. **Install Dependencies**
   Navigate to both working directories and install packages:
   ```bash
   cd leaderboardONO/backend
   npm install

   cd ../frontend
   npm install
   ```

2. **Start the Express Backend**
   In the `backend` directory:
   ```bash
   npm run start
   # Server will start on http://localhost:3000
   ```

3. **Start the Frontend & Vercel Functions**
   Because the system utilizes Vercel Serverless functions inside the `api/` directory, it is highly recommended to run the frontend utilizing the `vercel dev` CLI rather than standard `vite`.
   ```bash
   cd leaderboardONO/frontend
   vercel dev
   # Server will start on http://localhost:5173 
   # API routes will correctly bind to http://localhost:5173/api/*
   ```
   *(If you run `npm run dev`, Vite will start as normal, but the `/api/` endpoint routing will not execute locally).*

---

## 🎨 System Design Highlights

- **Aesthetics Elements**: The interface features a unique "Cormorant Garamond" & "Cinzel" cosmic brutalist design with particle integrations.
- **Fail-safes**: Both Vercel functions and Render servers operate asynchronously. Even if Postgres experiences sudden connection spikes resulting in throttling, the UI cache handles lock states securely until the queues process ensuring data integrity.

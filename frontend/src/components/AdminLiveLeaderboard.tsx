import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { supabase } from '../lib/supabase';
import { Trash2, Lock, Unlock, LogOut, RefreshCw } from 'lucide-react';

interface LeaderboardEntry {
  team_id: string;
  name: string;
  vote_count: number;
}

interface AdminUser {
  email: string;
  name?: string;
  credential: string;
}

interface LiveCountsResponse {
  counts: Record<string, number>;
  current_voting_session: string;
  voting_active: boolean;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Admin emails must match the backend ADMIN_EMAILS env var
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || 'aryansharma24106@gmail.com').split(',').map((e: string) => e.trim().toLowerCase());

const fetcher = (url: string) => fetch(url).then(res => res.json());

export default function AdminLiveLeaderboard() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [totalVotes, setTotalVotes] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  const [isVotingEnabled, setIsVotingEnabled] = useState<boolean>(true);
  const [isToggling, setIsToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<string>('');

  // Check if user is an admin
  const isAdmin = (email: string | undefined): boolean => {
    if (!email) return false;
    return ADMIN_EMAILS.includes(email.toLowerCase());
  };

  // Toggle voting state via authenticated endpoint
  const toggleVoting = async () => {
    if (!user?.credential) return;
    
    setIsToggling(true);
    setError(null);
    
    try {
      const res = await fetch(`${API_URL}/api/admin/toggle-voting`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.credential}`
        },
        body: JSON.stringify({ enabled: !isVotingEnabled })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to toggle voting');
      }
      
      setIsVotingEnabled(data.enabled);
      console.log(`✅ Voting ${data.enabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (err: any) {
      console.error('Toggle voting failed:', err);
      setError(err.message);
    } finally {
      setIsToggling(false);
    }
  };

  // Clear all votes via authenticated endpoint
  const clearAllVotes = async () => {
    if (!user?.credential) return;
    
    if (!window.confirm('⚠️ Are you sure you want to clear ALL votes? This action cannot be undone.')) return;
    
    setIsClearing(true);
    setError(null);
    
    try {
      const res = await fetch(`${API_URL}/api/admin/votes`, { 
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${user.credential}`
        }
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to clear votes');
      }
      
      // Reset local state
      setLeaderboard(prev => prev.map(t => ({ ...t, vote_count: 0 })));
      setTotalVotes(0);
      if (data.newSession) {
        setCurrentSession(data.newSession);
      }
      
      console.log(`✅ Votes cleared. New session: ${data.newSession}`);
    } catch (err: any) {
      console.error('Clear votes failed:', err);
      setError(err.message);
      alert(`Failed to clear votes: ${err.message}`);
    } finally {
      setIsClearing(false);
    }
  };

  // Load user from localStorage
  useEffect(() => {
    const storedUser = localStorage.getItem('google_user');
    if (storedUser) {
      try {
        const parsed = JSON.parse(storedUser);
        setUser({
          email: parsed.email,
          name: parsed.name,
          credential: parsed.credential
        });
      } catch {
        setUser(null);
      }
    }
  }, []);

  const logout = () => {
    localStorage.removeItem('google_user');
    window.location.href = '/';
  };

  // Poll for live counts
  const { data: liveData } = useSWR<LiveCountsResponse>(
    user && isAdmin(user.email) ? `/api/live-counts` : null,
    fetcher,
    { refreshInterval: 3000 }
  );

  // Update leaderboard from live data
  useEffect(() => {
    if (liveData) {
      setIsVotingEnabled(liveData.voting_active);
      setCurrentSession(liveData.current_voting_session);
      
      if (liveData.counts) {
        setLeaderboard((current) => {
          let updated = current.map(team => {
            const redisCount = liveData.counts[team.team_id];
            return {
              ...team,
              vote_count: redisCount !== undefined ? parseInt(String(redisCount)) : team.vote_count
            };
          });
          
          updated.sort((a, b) => {
            if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
            return a.name.localeCompare(b.name);
          });
          
          const newTotal = updated.reduce((acc, curr) => acc + curr.vote_count, 0);
          setTotalVotes(newTotal);
          
          return updated;
        });
      }
    }
  }, [liveData]);

  // Initial data fetch and realtime subscription
  useEffect(() => {
    if (!user || !isAdmin(user.email)) return;

    fetchLeaderboard();

    // Realtime listener for voting state changes
    const configChannel = supabase
      .channel('public:system_config')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_config' }, (payload) => {
        if (payload.new.key === 'voting_active') {
          setIsVotingEnabled(payload.new.value);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(configChannel);
    };
  }, [user]);

  const fetchLeaderboard = async () => {
    try {
      const { data, error } = await supabase
        .from('leaderboard')
        .select('*')
        .order('vote_count', { ascending: false })
        .order('name', { ascending: true });
        
      if (error) throw error;
      
      const typedData = (data || []).map(row => ({
        team_id: row.team_id,
        name: String(row.name),
        vote_count: Number(row.vote_count)
      }));
      
      setLeaderboard(typedData);
      setTotalVotes(typedData.reduce((acc, curr) => acc + curr.vote_count, 0));
    } catch (err) {
      console.error('Failed to fetch initial leaderboard:', err);
    }
  };

  // Access denied screen
  if (!user || !isAdmin(user.email)) {
    return (
      <div className="min-h-screen bg-linear-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] flex items-center justify-center text-white">
        <div className="bg-[#23272e] border border-[#222] rounded-xl p-10 text-center">
          <h1 className="text-3xl font-black uppercase tracking-wider text-[#FF3333] mb-4">
            Access Restricted
          </h1>
          <p className="text-gray-400 mb-6">
            {user ? `${user.email} is not authorized for admin access.` : 'Please sign in with an admin account.'}
          </p>
          <button
            onClick={() => window.location.href = '/'}
            className="px-6 py-3 bg-[#FF3333]/10 border border-[#FF3333] rounded-xl text-[#FF3333] font-black uppercase"
          >
            Return to Portal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] text-white flex flex-col font-sans">
      <header className="flex flex-col md:flex-row justify-between items-center p-4 md:p-8 border-b border-[#222] bg-[#23272e]/80 backdrop-blur-lg w-full shadow-[0_4px_30px_rgba(0,0,0,0.5)] gap-6 md:gap-0">
        <div className="flex items-center space-x-0 md:space-x-6 text-center md:text-left">
          <div className="flex flex-col">
            <h1 className="text-4xl md:text-6xl font-black uppercase tracking-tighter leading-none text-transparent bg-clip-text bg-linear-to-r from-[#f8fafc] to-[#a3a3a3]">
              Live Results
            </h1>
            <p className="text-xs md:text-sm text-[#FF3333] font-black uppercase tracking-[0.2em] md:tracking-[0.4em] mt-2">
              Admin Panel // Session: {currentSession.slice(-8) || 'N/A'}
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center space-y-4 sm:space-y-0 sm:space-x-8 text-center md:text-right bg-[#181818] p-4 border border-[#222] rounded-xl w-full md:w-auto">
          <div className="flex flex-col items-center sm:items-end pr-0 sm:pr-6 border-b sm:border-b-0 sm:border-r border-[#222] pb-4 sm:pb-0 w-full sm:w-auto">
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-1">
              Total Votes Cast
            </p>
            <p className="text-4xl md:text-6xl font-black text-white lining-nums leading-none tracking-tighter drop-shadow-[0_0_10px_rgba(255,255,255,0.2)]">
              {totalVotes.toLocaleString()}
            </p>
          </div>

          {/* Control Buttons */}
          <div className="flex flex-col gap-2 w-full sm:w-auto">
            {/* Error display */}
            {error && (
              <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            
            {/* Toggle Voting Button */}
            <button
              onClick={toggleVoting}
              disabled={isToggling}
              className={`flex items-center justify-center space-x-3 px-4 md:px-6 py-3 border rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 w-full ${
                isVotingEnabled 
                  ? 'bg-green-500/10 border-green-500 text-green-500 hover:bg-green-500/20' 
                  : 'bg-yellow-500/10 border-yellow-500 text-yellow-500 hover:bg-yellow-500/20'
              }`}
            >
              {isVotingEnabled ? <Unlock size={20} /> : <Lock size={20} />}
              <span className="font-black uppercase tracking-[0.3em] text-sm whitespace-nowrap">
                {isToggling ? 'Updating...' : isVotingEnabled ? 'Voting: OPEN' : 'Voting: LOCKED'}
              </span>
            </button>

            {/* Clear Votes Button */}
            <button
              onClick={clearAllVotes}
              disabled={isClearing}
              className="flex items-center justify-center space-x-3 bg-[#FF3333]/10 hover:bg-[#FF3333]/30 text-[#FF3333] px-4 md:px-6 py-3 border border-[#FF3333] rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-full"
            >
              {isClearing ? <RefreshCw size={20} className="animate-spin" /> : <Trash2 size={20} />}
              <span className="font-black uppercase tracking-[0.3em] text-sm whitespace-nowrap">
                {isClearing ? 'Clearing...' : 'Clear Votes'}
              </span>
            </button>
            
            {/* Logout Button */}
            <button
              onClick={logout}
              className="flex items-center justify-center space-x-2 px-4 py-2 border border-gray-600 text-gray-400 rounded-xl hover:bg-gray-800 hover:text-white transition-colors"
            >
              <LogOut size={18} />
              <span className="text-sm">Logout ({user.email})</span>
            </button>
          </div>
        </div>
      </header>

      {/* Leaderboard Table */}
      <main className="flex flex-col items-center justify-center py-8 md:py-12 px-2 md:px-4 w-full max-w-3xl mx-auto">
        <h2 className="text-2xl md:text-3xl font-black uppercase tracking-tight mb-6 md:mb-8 text-center">
          Leaderboard
        </h2>
        <div className="w-full bg-[#23272e]/80 border border-[#222] rounded-xl shadow-lg p-4 md:p-8 overflow-x-auto">
          {leaderboard.length > 0 ? (
            <table className="w-full text-left min-w-75">
              <thead>
                <tr>
                  <th className="text-sm md:text-lg font-bold uppercase text-gray-400 pb-4 pr-2">Position</th>
                  <th className="text-sm md:text-lg font-bold uppercase text-gray-400 pb-4">Team</th>
                  <th className="text-sm md:text-lg font-bold uppercase text-gray-400 pb-4 text-right md:text-left">Votes</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((team, idx) => (
                  <tr key={team.team_id} className="border-b border-[#222] last:border-none">
                    <td className="py-3 font-mono text-lg md:text-xl text-[#00FF66] font-black">{idx + 1}</td>
                    <td className="py-3 font-black text-white text-base md:text-lg uppercase">{team.name}</td>
                    <td className="py-3 font-mono text-xl md:text-2xl text-[#FF3333] font-black text-right md:text-left">{team.vote_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-gray-400 text-lg md:text-xl font-bold text-center py-12">
              No teams or votes yet.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
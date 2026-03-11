import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Trash2, Lock, Unlock, LogOut } from 'lucide-react'; // Added Lock icons

interface LeaderboardEntry {
  team_id: string;
  name: string;
  vote_count: number;
}

interface AdminUser {
  email: string;
  name?: string;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function AdminLiveLeaderboard() {

  const [user, setUser] = useState<unknown>(null);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [totalVotes, setTotalVotes] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  // --- New State for Toggle ---
  const [isVotingEnabled, setIsVotingEnabled] = useState<boolean>(true);
  const [isToggling, setIsToggling] = useState(false);

  const ADMIN_EMAIL = "aryansharma24106@gmail.com";

  // --- New Function to Toggle Voting ---
  const toggleVoting = async () => {
  setIsToggling(true);
  
  // 1. Try to fetch it first to see if we can even "see" it
  const { data: checkData } = await supabase
    .from('system_config')
    .select('*')
    .eq('key', 'voting_active');
    
  console.log("Can I see the row?", checkData);

  // 2. Perform the update
  const { data, error } = await supabase
    .from('system_config')
    .update({ value: !isVotingEnabled })
    .eq('key', 'voting_active')
    .select();

  if (error) {
    console.error("Update Error:", error.message);
  } else if (!data || data.length === 0) {
    console.error("0 rows updated. The key 'voting_active' likely doesn't exist in the table.");
  } else {
    console.log("Success! New value:", data[0].value);
    setIsVotingEnabled(data[0].value);
  }
  setIsToggling(false);
};

  const clearAllVotes = async () => {
    if (!window.confirm('⚠️ Are you sure you want to clear ALL votes? This action cannot be undone.')) return;
    
    setIsClearing(true);
    try {
      const res = await fetch(`${API_URL}/api/votes`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear votes');
      
      setLeaderboard(prev => prev.map(t => ({ ...t, vote_count: 0 })));
      setTotalVotes(0);
    } catch (err) {
      console.error('Clear votes failed:', err);
      alert('Failed to clear votes. Check console for details.');
    } finally {
      setIsClearing(false);
    }
  };

  useEffect(() => {
  const storedUser = localStorage.getItem("google_user");

    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        setUser(null);
      }
    }
  }, []);

  const logout = () => {
    localStorage.removeItem("google_user");
    window.location.href = "/";
  };


  useEffect(() => {

    if (!user || (user as AdminUser).email !== ADMIN_EMAIL) return;

    fetchLeaderboard();
    fetchInitialConfig(); // Fetch toggle state on load

    // Subscribe to Votes
    const voteChannel = supabase
      .channel('public:votes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, (payload) => {
        setLeaderboard((current) => {
          let updated = current.map(team => 
            team.team_id === payload.new.team_id 
              ? { ...team, vote_count: team.vote_count + 1 }
              : team
          );
          updated.sort((a, b) => {
            if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
            return a.name.localeCompare(b.name);
          });
          return updated;
        });
        setTotalVotes(current => current + 1);
      })
      .subscribe();

    // --- Realtime listener for Config Toggle ---
    const configChannel = supabase
      .channel('public:system_config')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_config' }, (payload) => {
        if (payload.new.key === 'voting_active') {
          setIsVotingEnabled(payload.new.value);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(voteChannel);
      supabase.removeChannel(configChannel);
    };
  }, [user]);

  const fetchInitialConfig = async () => {
    const { data } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'voting_active')
      .maybeSingle();
    if (data) setIsVotingEnabled(data.value);
  };

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


  if (!user || (user as AdminUser).email !== ADMIN_EMAIL) {
    return (
      <div className="min-h-screen bg-linear-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] flex items-center justify-center text-white">
        <div className="bg-[#23272e] border border-[#222] rounded-xl p-10 text-center">
          <h1 className="text-3xl font-black uppercase tracking-wider text-[#FF3333] mb-4">
            Access Restricted
          </h1>

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
              Fest 2026 // Real-time Vote Tracker
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

          {/* New Control Buttons Container */}
          <div className="flex flex-col gap-2 w-full sm:w-auto">
            {/* --- New Master Toggle Button --- */}
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


            <button
              onClick={clearAllVotes}
              disabled={isClearing}
              className="flex items-center justify-center space-x-3 bg-[#FF3333]/10 hover:bg-[#FF3333]/30 text-[#FF3333] px-4 md:px-6 py-3 border border-[#FF3333] rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-full"
            >
              <Trash2 size={20} className={isClearing ? 'animate-spin' : ''} />
              <span className="font-black uppercase tracking-[0.3em] text-sm whitespace-nowrap">
                {isClearing ? 'Clearing...' : 'Clear Votes'}
              </span>
            </button>
            <button
              onClick={logout}
              className="flex items-center space-x-2 px-4 py-2 border border-[#FF3333] text-[#FF3333] rounded-xl hover:bg-[#FF3333]/20"
            >
              <LogOut size={18} />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </header>

      {/* Leaderboard Table remains unchanged */}
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
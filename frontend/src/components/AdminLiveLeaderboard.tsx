import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Trash2 } from 'lucide-react';

interface LeaderboardEntry {
  team_id: string;
  name: string;
  vote_count: number;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function AdminLiveLeaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [totalVotes, setTotalVotes] = useState(0);
  const [isClearing, setIsClearing] = useState(false);

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
    fetchLeaderboard();
    const channel = supabase
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
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] text-white flex flex-col font-sans">
      {/* Header */}
      <header className="flex justify-between items-center p-8 border-b border-[#222] bg-[#23272e]/80 backdrop-blur-lg w-full shadow-[0_4px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center space-x-6">
          <div className="flex flex-col">
            <h1 className="text-6xl font-black uppercase tracking-tighter leading-none text-transparent bg-clip-text bg-gradient-to-r from-[#f8fafc] to-[#a3a3a3]">Live Results</h1>
            <p className="text-sm text-[#FF3333] font-black uppercase tracking-[0.4em] mt-2">Fest 2026 // Real-time Vote Tracker</p>
          </div>
        </div>
        <div className="flex items-center space-x-8 text-right bg-[#181818] p-4 border border-[#222] rounded-xl">
          <div className="flex flex-col items-end pr-6 border-r border-[#222]">
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-1">Total Votes Cast</p>
            <p className="text-6xl font-black text-white lining-nums leading-none tracking-tighter drop-shadow-[0_0_10px_rgba(255,255,255,0.2)]">{totalVotes.toLocaleString()}</p>
          </div>

          <button
            onClick={clearAllVotes}
            disabled={isClearing}
            className="flex items-center space-x-3 bg-[#FF3333]/10 hover:bg-[#FF3333]/30 text-[#FF3333] px-6 py-3 border border-[#FF3333] rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 size={20} className={isClearing ? 'animate-spin' : ''} />
            <span className="font-black uppercase tracking-[0.3em] text-sm">
              {isClearing ? 'Clearing...' : 'Clear Votes'}
            </span>
          </button>
        </div>
      </header>
      {/* Leaderboard Table */}
      <main className="flex flex-col items-center justify-center py-12 px-4 w-full max-w-3xl mx-auto">
        <h2 className="text-3xl font-black uppercase tracking-tight mb-8 text-center">Leaderboard</h2>
        <div className="w-full bg-[#23272e]/80 border border-[#222] rounded-xl shadow-lg p-8">
          {leaderboard.length > 0 ? (
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th className="text-lg font-bold uppercase text-gray-400 pb-4">Position</th>
                  <th className="text-lg font-bold uppercase text-gray-400 pb-4">Team</th>
                  <th className="text-lg font-bold uppercase text-gray-400 pb-4">Votes</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((team, idx) => (
                  <tr key={team.team_id} className="border-b border-[#222] last:border-none">
                    <td className="py-3 font-mono text-xl text-[#00FF66] font-black">{idx + 1}</td>
                    <td className="py-3 font-black text-white text-lg uppercase">{team.name}</td>
                    <td className="py-3 font-mono text-2xl text-[#FF3333] font-black">{team.vote_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-gray-400 text-xl font-bold text-center py-12">No teams or votes yet.</div>
          )}
        </div>
      </main>
    </div>
  );
}

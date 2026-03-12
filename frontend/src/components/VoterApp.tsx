import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Check, Flame, AlertCircle, LogOut, CheckCircle2, Lock } from 'lucide-react';

interface Team {
  id: string;
  name: string;
  description: string;
  image_url: string;
}

interface GoogleUser {
  id: string;
  email: string;
  name: string;
  picture: string;
  credential: string; // The ID token
}

declare global {
  interface Window {
    google: any;
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// A helper for team-specific border/accent colors based on index
const teamColors = [
  'border-[#00e5ff] text-[#00e5ff]', // Cyan
  'border-[#9461ff] text-[#9461ff]', // Purple
  'border-[#ff5e94] text-[#ff5e94]', // Pink
  'border-[#ffb732] text-[#ffb732]', // Yellow
  'border-[#ff3333] text-[#ff3333]', // Red
];

export default function VoterApp() {
  const [user, setUser] = useState<GoogleUser | null>(() => {
    const stored = localStorage.getItem('google_user');
    if (stored) {
      try { return JSON.parse(stored); } 
      catch { localStorage.removeItem('google_user'); }
    }
    return null;
  });
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  
  // --- New State for Voting Toggle ---
  const [isVotingEnabled, setIsVotingEnabled] = useState<boolean>(true);
  
  const googleBtnRef = useRef<HTMLDivElement>(null);

  const decodeJwt = (token: string) => {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(jsonPayload);
  };

  const handleCredentialResponse = useCallback((response: any) => {
    const credential = response.credential;
    const payload = decodeJwt(credential);

    const googleUser: GoogleUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      credential,
    };

    setUser(googleUser);
    localStorage.setItem('google_user', JSON.stringify(googleUser));
  }, []);

  // --- Realtime Listener for Master Toggle ---
  useEffect(() => {
    const fetchVotingStatus = async () => {
      const { data } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'voting_active')
        .maybeSingle();
      if (data !== null) setIsVotingEnabled(data.value);
    };

    const configChannel = supabase
      .channel('public:system_config')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_config' }, (payload) => {
        if (payload.new.key === 'voting_active') {
          setIsVotingEnabled(payload.new.value);
        }
      })
      .subscribe();

    fetchVotingStatus();
    return () => { supabase.removeChannel(configChannel); };
  }, []);

  useEffect(() => {
    const initGoogle = () => {
      if (window.google?.accounts?.id && !user) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: false,
        });
        if (googleBtnRef.current) {
          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'filled_black',
            size: 'large',
            width: 280, // <-- Reduced width from 380 to 280 to prevent overflow on mobile
            text: 'signin_with',
            shape: 'pill',
          });
        }
      }
    };

    if (window.google?.accounts?.id) {
      initGoogle();
    } else {
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          initGoogle();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [handleCredentialResponse, user]);

  useEffect(() => {
    if (user) {
      fetchTeams();
      checkVoteStatus();
    } else {
      setLoading(false);
    }
  }, [user]);

  const fetchTeams = async () => {
    try {
      const { data, error } = await supabase.from('teams').select('*').order('name');
      if (error) throw error;
      setTeams(data || []);
    } catch (err: any) {
      console.error('Error fetching teams:', err.message);
    } finally {
      setLoading(false);
    }
  };

  const checkVoteStatus = async () => {
    if (!user) return;
    
    // Optimistic UI check
    if (localStorage.getItem(`local_voted_${user.id}`) === 'true') {
      setVoted(true);
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/vote-status`, {
        headers: { 'Authorization': `Bearer ${user.credential}` }
      });
      const data = await res.json();
      if (data.hasVoted) {
        setVoted(true);
        localStorage.setItem(`local_voted_${user.id}`, 'true');
      }
    } catch (err) {
      console.error('Failed to check vote status:', err);
    }
  };

  const handleLogout = () => {
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    setUser(null);
    setVoted(false);
    setError(null);
    setSelectedTeam(null);
    localStorage.removeItem('google_user');
  };

  const handleVoteSubmit = async () => {
    if (!user || !selectedTeam) return;
    setVoting(true);
    setError(null);

    // Optimistic UI: Lock the vote immediately
    setVoted(true);
    localStorage.setItem(`local_voted_${user.id}`, 'true');

    try {
      const response = await fetch(`${API_URL}/api/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.credential}`
        },
        body: JSON.stringify({ teamId: selectedTeam })
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 400 && data.error === 'Already Voted') {
          // They already voted, keep it locked
          setVoted(true);
          localStorage.setItem(`local_voted_${user.id}`, 'true');
        } else if (response.status === 401) {
          handleLogout();
          setError('Session expired. Please sign in again.');
          // Revert optimistic lock
          setVoted(false);
          localStorage.removeItem(`local_voted_${user.id}`);
        } else {
          // Revert optimistic lock on generic failure
          setVoted(false);
          localStorage.removeItem(`local_voted_${user.id}`);
          throw new Error(data.error || 'Failed to vote');
        }
      } else {
        // Success
        setVoted(true);
      }
    } catch (err: any) {
      setError(err.message);
      setVoted(false);
      localStorage.removeItem(`local_voted_${user.id}`);
    } finally {
      setVoting(false);
    }
  };

  // -----------------------------
  // RENDER: VOTING LOCKED SCREEN
  if (!isVotingEnabled && !voted) {
    return (
      <div className="min-h-screen bg-[#050508] relative overflow-hidden flex flex-col items-center justify-center p-6 text-white font-['Cormorant_Garamond']">
        <div className="absolute inset-0 bg-[url('/favicon-nobg.png')] bg-size-[280px_280px] lg:bg-size-[350px_350px] bg-position-[center_top_12rem] bg-no-repeat bg-fixed opacity-15 pointer-events-none"></div>
        <div className="stars-container"></div>
        <div className="stars-container-2"></div>
        
        <div className="relative z-10 flex flex-col items-center max-w-sm w-full space-y-8 text-center">
          <div className="text-yellow-500 animate-pulse">
            <Lock size={64} className="drop-shadow-[0_0_15px_rgba(234,179,8,0.4)]" />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-['Cinzel'] font-black tracking-widest text-[#f8fafc]">
              VOTING PAUSED
            </h1>
            <p className="text-xl text-gray-400 italic">
              The cosmic polls are currently closed by the administrator. 
              Keep an eye on the live leaderboard for results!
            </p>
          </div>
          <div className="w-full h-px bg-linear-to-r from-transparent via-yellow-500/30 to-transparent"></div>
          {user && (
             <button onClick={handleLogout} className="flex items-center space-x-2 text-gray-500 hover:text-white transition-colors">
                <LogOut size={18} />
                <span className="text-lg uppercase tracking-widest font-['Cinzel']">Sign Out</span>
             </button>
          )}
        </div>
      </div>
    );
  }

  // RENDER: VOTED CONFIRMATION
  if (voted) {
    return (
      <div className="min-h-screen bg-[#050508] relative overflow-hidden flex flex-col items-center justify-center p-6 text-white font-['Cormorant_Garamond']">
        
        {/* Background Image & Stars */}
        <div className="absolute inset-0 bg-[url('/favicon-nobg.png')] bg-size-[280px_280px] lg:bg-size-[350px_350px] bg-position-[center_top_12rem] bg-no-repeat bg-fixed opacity-15 pointer-events-none"></div>
        <div className="stars-container"></div>
        <div className="stars-container-2"></div>

        {/* Subtle background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-200 h-200 bg-[radial-gradient(circle,rgba(0,229,255,0.05)_0%,transparent_70%)] pointer-events-none"></div>

        <div className="relative z-10 flex flex-col items-center max-w-sm w-full space-y-8">
          <div className="text-[#00e5ff]">
            <CheckCircle2 size={64} className="drop-shadow-[0_0_15px_rgba(0,229,255,0.4)]" />
          </div>
          <div className="text-center space-y-4">
            <h1 className="text-5xl font-['Cinzel'] font-black tracking-widest text-[#f8fafc] drop-shadow-md">
              VOTED
            </h1>
            <p className="text-xl text-gray-400 italic">
              Your voice has been recorded in the cosmos.
            </p>
          </div>
          
          <div className="w-full border border-gray-800 rounded-3xl p-6 bg-[#0a0a10]/80">
            <p className="text-sm tracking-[0.2em] text-gray-500 uppercase mb-2 font-['Cinzel']">Authenticated As</p>
            <p className="text-xl font-semibold">{user?.email}</p>
            <p className="text-sm text-gray-400 mt-1">{user?.name}</p>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center space-x-2 text-gray-500 hover:text-white transition-colors cursor-pointer"
          >
            <LogOut size={18} />
            <span className="text-lg uppercase tracking-widest font-['Cinzel']">Sign Out</span>
          </button>
        </div>
      </div>
    );
  }

  // -----------------------------
  // RENDER: MAIN APP
  // -----------------------------
  return (
    <div className="min-h-screen bg-[#050508] text-white flex justify-center relative overflow-hidden font-['Cormorant_Garamond']">
      
      {/* Background Image & Stars */}
      <div className="absolute inset-0 bg-[url('/favicon-nobg.png')] bg-size-[280px_280px] lg:bg-size-[350px_350px] bg-position-[center_top_12rem] bg-no-repeat bg-fixed opacity-15 pointer-events-none"></div>
      <div className="stars-container"></div>
      <div className="stars-container-2"></div>
      
      {/* Background Starry/Cosmic Glows */}
      <div className="absolute top-0 left-0 w-full h-125 bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.08)_0%,transparent_70%)] pointer-events-none"></div>
      <div className="absolute top-10 right-10 w-75 h-75 bg-[radial-gradient(circle,rgba(148,97,255,0.05)_0%,transparent_70%)] pointer-events-none"></div>

      <div className="w-full max-w-md flex flex-col relative z-10 pb-40"> {/* Bottom padding for fixed footer */}
        
        {/* HEADER */}
        <div className="pt-12 pb-8 px-6 flex flex-col items-center text-center space-y-6">
          <div className="inline-flex items-center space-x-3 px-5 py-1.5 rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/5 backdrop-blur-sm">
            <span className="text-[#00e5ff] text-xs">✸</span>
            <span className="font-['Cinzel'] text-xs font-bold tracking-[0.25em] text-[#00e5ff] uppercase">
              Fest 2026 // Live
            </span>
            <span className="text-[#00e5ff] text-xs">✸</span>
          </div>
          
          <h1 className="text-5xl font-['Cinzel'] font-black tracking-wide leading-tight text-white drop-shadow-lg">
            CAST YOUR<br/>VOTE NOW.
          </h1>
          
          <div className="flex flex-col items-center">
            <h2 className="font-['Cinzel'] text-[#8c6ae6] text-sm tracking-[0.4em] font-bold uppercase mb-4">
              Oneiros 2026
            </h2>
            <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[6px] border-b-[#00e5ff]"></div>
            <div className="w-full h-px bg-linear-to-r from-transparent via-[#00e5ff]/30 to-transparent mt-px mx-10"></div>
          </div>
        </div>

        {!user ? (
          /* LOGIN SCREEN */
          <div className="px-6 space-y-6 mt-8">
            <div className="bg-[#121215]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-8 flex flex-col items-center text-center space-y-6 shadow-2xl">
              <p className="text-xl text-gray-400 italic">
                Authenticate your identity to cast your ballot in the cosmos.
              </p>
              {error && (
                <div className="bg-red-500/10 border border-red-500/50 p-4 w-full rounded-xl flex items-center justify-center space-x-2 text-red-400">
                  <AlertCircle size={18} />
                  <span className="font-sans text-sm">{error}</span>
                </div>
              )}
              {/* Added w-full flex justify-center to ensure button centers properly */}
              <div className="w-full flex justify-center py-4">
                <div ref={googleBtnRef} className="flex justify-center w-full"></div>
              </div>
            </div>
          </div>
        ) : (
          /* VOTING SELECTION */
          <div className="px-6 space-y-8 grow">
            
            {error && (
              <div className="bg-red-500/10 border border-red-500/50 p-4 rounded-xl flex items-center space-x-2 text-red-400">
                <AlertCircle size={18} />
                <span className="font-sans text-sm">{error}</span>
              </div>
            )}

            {/* User Card */}
            <div className="relative bg-[#0d0f12] rounded-2xl overflow-hidden border border-gray-800/80 p-5 pl-6 shadow-xl group">
              {/* Cyan left border highlight */}
              <div className="absolute left-0 top-0 bottom-0 w-0.75 bg-linear-to-b from-[#00e5ff] to-[#0088ff] shadow-[0_0_10px_rgba(0,229,255,0.5)]"></div>
              
              <div className="flex justify-between items-start">
                <div className="flex flex-col flex-wrap">
                  <span className="font-['Cinzel'] text-[10px] text-gray-500 tracking-[0.2em] font-bold uppercase mb-1">Authenticated As</span>
                  <span className="text-lg font-semibold text-gray-100 break-all">{user.email}</span>
                  <span className="text-sm text-gray-400 mt-1 flex items-center flex-wrap gap-2">
                    Name: {user.name} <span className="hidden sm:inline">·</span> 
                    <button onClick={handleLogout} className="hover:text-white transition-colors flex items-center"><LogOut size={14} className="mr-1"/> Logout</button>
                  </span>
                </div>
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 shrink-0 ml-2">
                  <Check size={12} strokeWidth={3} />
                  <span className="text-[10px] font-['Cinzel'] font-bold tracking-widest uppercase">Verified</span>
                </div>
              </div>
            </div>

            {/* Team List */}
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-gray-800/80">
                <h3 className="font-['Cinzel'] text-xs font-bold tracking-[0.3em] text-gray-400 uppercase">Select Team</h3>
                <span className="text-sm font-['Cinzel'] text-[#00e5ff] tracking-widest">{teams.length} competing</span>
              </div>

              {loading ? (
                <div className="space-y-4 animate-pulse pt-2">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="h-24 bg-[#121215] rounded-3xl border border-gray-800"></div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4 pt-2 pb-8">
                  {teams.map((team, idx) => {
                    const isSelected = selectedTeam === team.id;
                    const accentClass = teamColors[idx % teamColors.length];
                    const [accentBorder, accentText] = accentClass.split(' ');

                    return (
                      <button
                        key={team.id}
                        onClick={() => setSelectedTeam(team.id)}
                        className={`w-full relative flex items-center p-4 rounded-3xl border transition-all duration-300 ${
                          isSelected 
                            ? `border-gray-500 bg-[#16161c]` 
                            : 'border-gray-800/80 bg-[#121215] hover:border-gray-600 hover:bg-[#16161c]'
                        }`}
                      >
                        {/* Team Initial Box */}
                        <div className={`h-14 w-14 rounded-2xl border ${accentBorder} bg-black/50 shrink-0 flex items-center justify-center shadow-[inset_0_0_15px_rgba(0,0,0,0.5)]`}>
                          <span className={`font-['Cinzel'] font-black text-2xl ${accentText} drop-shadow-[0_0_8px_currentColor]`}>
                            {team.name.charAt(0)}
                          </span>
                        </div>
                        
                        {/* Text Content */}
                        <div className="ml-4 grow text-left">
                          <h4 className={`font-['Cinzel'] text-xl font-bold tracking-wider uppercase transition-colors ${isSelected ? 'text-white' : 'text-gray-200'}`}>
                            {team.name}
                          </h4>
                          <p className="text-sm text-gray-400 mt-1 italic leading-tight">
                            {team.description}
                          </p>
                        </div>

                        {/* Selection Radio */}
                        <div className="ml-4 shrink-0 flex items-center justify-center p-2">
                          <div className={`h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all ${
                            isSelected ? 'border-[#00e5ff] bg-[#00e5ff]/10' : 'border-gray-600'
                          }`}>
                            {isSelected && <div className="h-2.5 w-2.5 rounded-full bg-[#00e5ff] shadow-[0_0_8px_#00e5ff]"></div>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* FIXED FOOTER (Only when logged in) */}
      {user && !loading && (
        <div className="fixed bottom-0 left-0 w-full bg-[#050508]/90 backdrop-blur-xl border-t border-gray-900/50 flex justify-center z-50 px-4 py-4 pb-8">
          <div className="w-full max-w-md flex flex-col items-center space-y-3">
            <p className="text-sm text-gray-500 font-['Cinzel'] tracking-widest text-center">
              {selectedTeam ? "Team Selected. Ready to cast." : "Select a team above to vote"}
            </p>
            
            <button
              onClick={handleVoteSubmit}
              disabled={!selectedTeam || voting}
              className={`w-full py-4 rounded-3xl font-['Cinzel'] font-bold text-xl tracking-[0.2em] transition-all duration-500 uppercase flex justify-center items-center shadow-2xl ${
                selectedTeam
                  ? 'bg-linear-to-r from-[#0f4b50] via-[#2a304e] to-[#4b1d3f] text-gray-100 hover:shadow-[0_0_30px_rgba(0,229,255,0.2)] hover:text-white border border-gray-500/30'
                  : 'bg-[#121215] text-gray-600 border border-gray-800 cursor-not-allowed'
              }`}
            >
              {voting ? (
                <span className="flex items-center space-x-2">
                  <Flame className="animate-pulse text-[#00e5ff]" size={20} />
                  <span>Casting...</span>
                </span>
              ) : "Submit Vote"}
            </button>
            <p className="text-xs text-gray-600 mt-2 font-sans tracking-wide">
              One vote per student · Votes are final and cannot be changed
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
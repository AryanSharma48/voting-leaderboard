import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Check, Flame, AlertCircle, LogOut } from 'lucide-react';

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

export default function VoterApp() {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Decode JWT payload (Google ID token is a JWT)
  const decodeJwt = (token: string) => {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(jsonPayload);
  };

  // Handle Google sign-in callback
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

  // Initialize Google Sign-In
  useEffect(() => {
    // Check for stored session
    const stored = localStorage.getItem('google_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setUser(parsed);
      } catch {
        localStorage.removeItem('google_user');
      }
    }

    // Wait for Google script to load
    const initGoogle = () => {
      if (window.google?.accounts?.id) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: false,
        });
        if (googleBtnRef.current) {
          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'filled_black',
            size: 'large',
            width: 380,
            text: 'signin_with',
            shape: 'pill',
          });
        }
      }
    };

    // If script already loaded
    if (window.google?.accounts?.id) {
      initGoogle();
    } else {
      // Wait for script to load
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          initGoogle();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [handleCredentialResponse]);

  // Re-render button when user logs out (ref becomes available again)
  useEffect(() => {
    if (!user && googleBtnRef.current && window.google?.accounts?.id) {
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'filled_black',
        size: 'large',
        width: 380,
        text: 'signin_with',
        shape: 'pill',
      });
    }
  }, [user]);

  // Fetch teams + check vote status when user is available
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
    try {
      const res = await fetch(`${API_URL}/api/vote-status`, {
        headers: { 'Authorization': `Bearer ${user.credential}` }
      });
      const data = await res.json();
      if (data.hasVoted) {
        setVoted(true);
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
    localStorage.removeItem('google_user');
  };

  const handleVote = async (teamId: string) => {
    if (!user) return;
    setVoting(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.credential}`
        },
        body: JSON.stringify({ teamId })
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 400 && data.error === 'Already Voted') {
          setVoted(true);
        } else if (response.status === 401) {
          // Token expired, force re-login
          handleLogout();
          setError('Session expired. Please sign in again.');
        } else {
          throw new Error(data.error || 'Failed to vote');
        }
      } else {
        setVoted(true);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVoting(false);
    }
  };

  // Voted confirmation screen
  if (voted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] flex flex-col items-center justify-center p-6">
        <div className="bg-[#23272e]/80 backdrop-blur-lg border border-[#222] rounded-2xl p-8 max-w-sm w-full shadow-2xl space-y-4">
          <div className="flex items-center space-x-3 text-[#00FF66]">
            <Check size={40} className="drop-shadow-[0_0_15px_rgba(0,255,102,0.8)]" />
            <h1 className="text-3xl font-black uppercase tracking-tighter">Vote Recorded</h1>
          </div>
          <p className="text-gray-300 font-medium">
            Your vote has been locked in for the festival. Check the main projector for live updates!
          </p>
          <p className="text-gray-500 text-sm">
            Signed in as {user?.email}
          </p>
          <button
            onClick={handleLogout}
            className="flex items-center space-x-2 text-gray-400 hover:text-white text-sm transition-colors mt-2 cursor-pointer"
          >
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#181818] via-[#23272e] to-[#0d0d0d] text-white flex justify-center pb-20 relative overflow-hidden">
      <div className="w-full max-w-md px-4 mt-8 space-y-8 relative z-10">
        {/* Header */}
        <div className="space-y-1 py-4 border-b-2 border-[#222] flex flex-col justify-end min-h-[120px]">
          <div className="flex items-center space-x-2 text-[#FF3333]">
            <Flame size={28} className="animate-pulse drop-shadow-[0_0_8px_rgba(255,51,51,0.8)]" />
            <span className="font-black text-xs tracking-[0.3em] uppercase opacity-80">Fest 2026 // Live</span>
          </div>
          <h1 className="text-5xl font-black uppercase tracking-tighter leading-[0.85] mt-2 pb-2 text-transparent bg-clip-text bg-gradient-to-r from-[#f8fafc] to-[#a3a3a3]">
            Cast Your<br/>Vote Now.
          </h1>
        </div>

        {!user ? (
          /* Login Screen */
          <div className="bg-[#23272e]/80 backdrop-blur-lg border border-[#222] rounded-2xl p-6 space-y-6 shadow-2xl">
            <p className="text-gray-300 font-medium">
              Sign in with your Google account to cast your vote. One account, one vote.
            </p>
            {error && (
              <div className="bg-[#FF3333]/10 border border-[#FF3333] p-3 flex items-center space-x-3 text-[#FF3333] rounded-xl">
                <AlertCircle size={18} />
                <span className="text-sm font-bold">{error}</span>
              </div>
            )}
            {/* Google's own rendered sign-in button */}
            <div className="flex justify-center">
              <div ref={googleBtnRef}></div>
            </div>
          </div>
        ) : (
          /* Voting Screen */
          <div className="space-y-6">
            <div className="bg-[#23272e]/80 backdrop-blur-lg border border-[#00FF66] rounded-xl p-4 flex justify-between items-center text-sm font-bold">
              <div className="flex items-center space-x-3">
                {user.picture && (
                  <img src={user.picture} alt="" className="w-8 h-8 rounded-full" />
                )}
                <div className="flex flex-col">
                  <span className="text-[10px] text-gray-400 tracking-widest uppercase mb-1">Signed In As</span>
                  <span className="text-white truncate max-w-[200px]">{user.email}</span>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <span className="uppercase text-[#00FF66] text-xs font-black tracking-[0.2em] px-2 py-1 shadow-[0_0_10px_rgba(0,255,102,0.2)] rounded-lg bg-[#181818]">Verified</span>
                <button onClick={handleLogout} className="text-gray-400 hover:text-white transition-colors cursor-pointer" title="Sign out">
                  <LogOut size={16} />
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-[#FF3333]/10 border border-[#FF3333] p-4 flex items-center space-x-3 text-[#FF3333] animate-pulse rounded-xl">
                <AlertCircle size={20} />
                <span className="text-sm font-bold tracking-widest uppercase">{error}</span>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-black text-gray-400 uppercase tracking-[0.3em]">Select Team</h2>
                <div className="h-[1px] bg-gray-700 flex-grow ml-4"></div>
              </div>
              {loading ? (
                <div className="animate-pulse flex flex-col space-y-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-24 bg-[#23272e]/80 border border-[#222] rounded-xl w-full" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-4">
                  {teams.map((team, idx) => (
                    <div 
                      key={team.id} 
                      className="group relative border border-[#222] bg-[#181818]/80 rounded-xl hover:border-[#FF3333] transition-all duration-300 hover:shadow-[0_0_25px_rgba(255,51,51,0.15)] overflow-hidden"
                      style={{ animationDelay: `${idx * 100}ms` }}
                    >
                      <div className="absolute inset-0 bg-[#FF3333]/5 translate-y-[100%] group-hover:translate-y-0 transition-transform duration-300 rounded-xl"></div>
                      <button
                        onClick={() => handleVote(team.id)}
                        disabled={voting}
                        className="w-full text-left flex items-center p-4 relative z-10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="h-16 w-16 bg-[#23272e] border border-[#222] rounded-xl flex-shrink-0 flex items-center justify-center overflow-hidden group-hover:border-[#FF3333]/50 transition-colors">
                          {team.image_url ? (
                            <img src={team.image_url} alt={team.name} className="h-full w-full object-cover grayscale mix-blend-luminosity group-hover:mix-blend-normal group-hover:grayscale-0 transition-all duration-500 group-hover:scale-110 rounded-xl" />
                          ) : (
                            <span className="font-black text-3xl text-gray-400 group-hover:text-[#FF3333] transition-colors">{team.name.charAt(0)}</span>
                          )}
                        </div>
                        <div className="ml-5 flex-grow">
                          <h3 className="font-black text-2xl uppercase tracking-tighter group-hover:text-white text-gray-200 transition-colors">{team.name}</h3>
                          <p className="text-xs text-gray-400 line-clamp-1 mt-1 font-medium tracking-wide">{team.description}</p>
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-x-4 group-hover:translate-x-0 pr-2 text-[#FF3333]">
                          <Check size={28} className="drop-shadow-[0_0_8px_rgba(255,51,51,0.8)]" />
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

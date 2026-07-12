'use client';

import React, { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

interface Player {
  id: string;
  name: string;
  is_tentative: boolean;
  status: 'active' | 'waitlist';
  game_id: string;
}

interface GameSlot {
  id: string;
  date: string; // Stored as DATE in DB
  time: string;
  level: string;
  location: string;
  max_players: number;
  booked_by: string;
}

// Utility to format date nicely (e.g., "2023-10-15" to "Oct 15, 2023")
const formatDate = (dateString: string) => {
  if (!dateString) return '';
  const dateObj = new Date(dateString);
  if (isNaN(dateObj.getTime())) return dateString; 
  
  return new Intl.DateTimeFormat('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric',
    timeZone: 'UTC' // Prevent timezone shift issues with raw dates
  }).format(dateObj);
};

// Utility to convert "18:00" to "6:00 PM"
const formatTime12h = (time24: string) => {
  if (!time24) return '';
  try {
    const [hours, minutes] = time24.split(':');
    const h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
  } catch (e) {
    return time24;
  }
};

// Utility to parse "6:00 PM" back to "18:00" for the input
const parseTimeTo24h = (time12h: string) => {
  try {
    const match = time12h.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return '';
    let [_, hStr, m, ampm] = match;
    let h = parseInt(hStr, 10);
    if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:${m}`;
  } catch (e) {
    return '';
  }
};

export default function BadmintonScheduler() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // App State
  const [view, setView] = useState<'list' | 'details' | 'form'>('list');
  const [games, setGames] = useState<GameSlot[]>([]);
  const [selectedGame, setSelectedGame] = useState<GameSlot | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  
  // User Actions
  const [playerName, setPlayerName] = useState('');
  const [isTentativeInput, setIsTentativeInput] = useState(false);

  // Auth State
  const [email, setEmail] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [authError, setAuthError] = useState('');

  // Form State
  const [formData, setFormData] = useState<Partial<GameSlot> & { startTime?: string; endTime?: string }>({});
  const [formError, setFormError] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user?.user_metadata?.full_name) {
        setPlayerName(session.user.user_metadata.full_name);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user?.user_metadata?.full_name) {
        setPlayerName(session.user.user_metadata.full_name);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }

    const fetchGames = async () => {
      // Filter out past games on the frontend just in case cron hasn't run
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('games')
        .select('*')
        .gte('date', today)
        .order('date', { ascending: true })
        .order('time', { ascending: true });
        
      if (data) setGames(data);
      setLoading(false);
    };

    fetchGames();

    const gamesSub = supabase
      .channel('games_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, () => {
        fetchGames();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(gamesSub);
    };
  }, [session]);

  useEffect(() => {
    if (view === 'details' && selectedGame) {
      const fetchPlayers = async () => {
        const { data } = await supabase
          .from('players')
          .select('*')
          .eq('game_id', selectedGame.id)
          .order('created_at', { ascending: true });
        if (data) setPlayers(data);
      };

      fetchPlayers();

      const playersSub = supabase
        .channel('players_channel')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${selectedGame.id}` },
          () => {
            fetchPlayers();
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(playersSub);
      };
    }
  }, [view, selectedGame?.id]);

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setAuthError(error.message);
    else setOtpSent(true);
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim() || !selectedGame || !session) return;

    const activePlayersCount = players.filter((p) => p.status === 'active').length;
    const isFull = activePlayersCount >= selectedGame.max_players;
    const status = isFull ? 'waitlist' : 'active';

    await supabase.from('players').insert([
      {
        game_id: selectedGame.id,
        name: playerName.trim(),
        is_tentative: isTentativeInput,
        status: status,
      },
    ]);

    setPlayerName(session.user.user_metadata?.full_name || '');
    setIsTentativeInput(false);
  };

  const handleSaveGame = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    
    // Combine start and end time if using the time pickers
    const combinedTime = formData.startTime && formData.endTime 
      ? `${formatTime12h(formData.startTime)} - ${formatTime12h(formData.endTime)}` 
      : formData.time;

    if (!formData.date || !combinedTime || !formData.level || !formData.location || !formData.max_players || !formData.booked_by) {
      setFormError('Please fill in all required fields.');
      return;
    }

    let response;

    if (formData.id) {
      response = await supabase.from('games').update({
        date: formData.date,
        time: combinedTime,
        level: formData.level,
        location: formData.location,
        max_players: formData.max_players,
        booked_by: formData.booked_by
      }).eq('id', formData.id);
    } else {
      response = await supabase.from('games').insert([{
        date: formData.date,
        time: combinedTime,
        level: formData.level,
        location: formData.location,
        max_players: formData.max_players,
        booked_by: formData.booked_by
      }]);
    }

    if (response.error) {
      if (response.error.code === '23505') {
        setFormError('A match is already scheduled for this date and time!');
      } else {
        setFormError('An error occurred. Please try again.');
      }
    } else {
      setView('list');
    }
  };

  const handleDeleteGame = async (gameId: string) => {
    if (!window.confirm("Are you sure you want to delete this match? This cannot be undone.")) return;
    
    setFormError('');
    const { error } = await supabase.from('games').delete().eq('id', gameId);
    
    if (error) {
      setFormError('Failed to delete match. Please try again.');
    } else {
      setView('list');
    }
  };

  const copyToClipboard = () => {
    if (!selectedGame) return;
    const activePlayers = players.filter((p) => p.status === 'active');
    const waitlisted = players.filter((p) => p.status === 'waitlist');

    const playerListText = activePlayers.length > 0
      ? activePlayers.map((p, i) => `${i + 1}. ${p.name}${p.is_tentative ? ' (Tentative)' : ''}`).join('\n')
      : '1. ';

    const waitlistText = waitlisted.length > 0
      ? waitlisted.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
      : '1. ';

    const formattedDate = formatDate(selectedGame.date);

    const template = `🏸 *Badminton Match*\nChoose a slot and put down the details.\n\n📅 Date: ${formattedDate}\n⏰ Time: ${selectedGame.time}\n🏅 Level: ${selectedGame.level}\n📍 Location: ${selectedGame.location}\n📌 No. of players required: ${selectedGame.max_players}\n👤 Booked by: ${selectedGame.booked_by}\n\nInterested members can put their names below.\n\n${playerListText}\n\nWaiting list\n${waitlistText}`;

    navigator.clipboard.writeText(template);
    alert('Copied to clipboard! Ready to paste in WhatsApp.');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-12 h-12 bg-emerald-500 rounded-full blur-xl opacity-50 mb-4"></div>
          <p className="text-emerald-400 font-medium tracking-widest uppercase text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  // --- VIEW: LOGIN ---
  if (!session) {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-emerald-500/20 rounded-full blur-3xl opacity-30 mix-blend-screen pointer-events-none"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-blue-500/20 rounded-full blur-3xl opacity-30 mix-blend-screen pointer-events-none"></div>
        
        <div className="w-full max-w-md bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl text-center space-y-6 relative z-10">
          <div className="w-16 h-16 bg-gradient-to-br from-emerald-400 to-teal-600 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/20 mb-6 text-2xl">
            🏸
          </div>
          <h1 className="text-3xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-cyan-400">
            Smash Scheduler
          </h1>
          <p className="text-slate-400 text-sm">Enter your email to receive a secure, passwordless login link.</p>
          
          {otpSent ? (
            <div className="bg-emerald-500/10 text-emerald-400 p-4 rounded-2xl border border-emerald-500/20 text-sm font-medium animate-fade-in">
              ✨ Magic link sent! Check your email to securely sign in.
            </div>
          ) : (
            <form onSubmit={sendMagicLink} className="space-y-4 mt-6">
              <input
                type="email"
                required
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-950/50 border border-slate-700/50 rounded-2xl px-5 py-4 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all placeholder:text-slate-600"
              />
              <button
                type="submit"
                className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 active:scale-[0.98]"
              >
                Send Magic Link
              </button>
              {authError && <p className="text-red-400 text-xs mt-3 font-medium bg-red-500/10 p-2 rounded-lg">{authError}</p>}
            </form>
          )}
        </div>
      </div>
    );
  }

  // --- VIEW: FORM (Create/Edit Game) ---
  if (view === 'form') {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col items-center p-4 font-sans selection:bg-emerald-500 selection:text-slate-900">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl mt-6 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-400 to-cyan-400"></div>
          
          <div className="flex items-center mb-8 gap-4">
            <button onClick={() => { setView('list'); setFormError(''); }} className="text-slate-400 hover:text-emerald-400 transition-colors p-2 -ml-2 rounded-xl hover:bg-slate-800">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <h2 className="text-2xl font-bold">{formData.id ? 'Edit Match' : 'New Match'}</h2>
          </div>
          
          {formError && (
            <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {formError}
            </div>
          )}

          <form onSubmit={handleSaveGame} className="space-y-5">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Date</label>
              <input type="date" required value={formData.date || ''} onChange={(e) => setFormData({...formData, date: e.target.value})} className="w-full mt-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all" style={{ colorScheme: 'dark' }} />
            </div>
            <div className="grid grid-cols-[1.5fr_1fr] gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Time</label>
                <div className="flex items-center gap-2 mt-2">
                  <input type="time" required value={formData.startTime || ''} onChange={(e) => setFormData({...formData, startTime: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all color-scheme-dark" style={{ colorScheme: 'dark' }} />
                  <span className="text-slate-500 font-bold">to</span>
                  <input type="time" required value={formData.endTime || ''} onChange={(e) => setFormData({...formData, endTime: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all color-scheme-dark" style={{ colorScheme: 'dark' }} />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Level</label>
                <div className="relative">
                  <select required value={formData.level || ''} onChange={(e) => setFormData({...formData, level: e.target.value})} className="w-full mt-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3.5 text-sm text-slate-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all appearance-none cursor-pointer">
                    <option value="" disabled>Select Level</option>
                    <option value="Beginner">Beginner</option>
                    <option value="Beginner++">Beginner++</option>
                    <option value="Intermediate">Intermediate</option>
                    <option value="Intermediate++">Intermediate++</option>
                    <option value="Advanced">Advanced</option>
                  </select>
                  <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none mt-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Location</label>
              <input type="text" required placeholder="e.g. OTM Sports Arena" value={formData.location || ''} onChange={(e) => setFormData({...formData, location: e.target.value})} className="w-full mt-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Max Players</label>
                <input type="number" required min="2" max="20" value={formData.max_players || 6} onChange={(e) => setFormData({...formData, max_players: parseInt(e.target.value)})} className="w-full mt-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-1">Booked By</label>
                <input type="text" required placeholder="Your Name" value={formData.booked_by || ''} onChange={(e) => setFormData({...formData, booked_by: e.target.value})} className="w-full mt-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3.5 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all" />
              </div>
            </div>
            <div className={`grid ${formData.id ? 'grid-cols-[1fr_auto]' : 'grid-cols-1'} gap-3 mt-8`}>
              <button type="submit" className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 active:scale-[0.98]">
                {formData.id ? 'Save Changes' : 'Create Match'}
              </button>
              {formData.id && (
                <button type="button" onClick={() => handleDeleteGame(formData.id!)} className="w-14 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/40 font-bold rounded-2xl transition-all flex items-center justify-center active:scale-[0.98]" title="Delete Match">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    );
  }

  // --- VIEW: LIST (All Games) ---
  if (view === 'list') {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col items-center p-4 font-sans">
        <div className="w-full max-w-md mt-4 mb-2 flex justify-between items-center px-2">
          <div className="flex items-center gap-2">
             <span className="text-2xl">🏸</span>
             <h1 className="text-xl font-bold text-slate-100">Matches</h1>
          </div>
          <button onClick={() => supabase.auth.signOut()} className="text-xs font-medium text-slate-400 hover:text-red-400 transition-colors bg-slate-800/50 px-3 py-1.5 rounded-full border border-slate-700/50">Sign Out</button>
        </div>

        <div className="w-full max-w-md">
          <button 
            onClick={() => { 
              setFormData({ max_players: 6, booked_by: playerName || '' }); 
              setFormError('');
              setView('form'); 
            }}
            className="w-full mb-6 bg-slate-900 hover:bg-slate-800 text-emerald-400 border border-emerald-500/30 hover:border-emerald-400 font-semibold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/5 hover:shadow-emerald-500/10 active:scale-[0.99] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            Propose New Match
          </button>

          {games.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-10 text-center shadow-xl">
              <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl grayscale opacity-50">🏟️</div>
              <p className="text-slate-400 font-medium">No matches scheduled yet.</p>
              <p className="text-slate-500 text-sm mt-2">Be the first to propose a game!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {games.map((g) => (
                <div key={g.id} className="bg-slate-900 border border-slate-800 rounded-3xl p-5 cursor-pointer hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-500/5 transition-all group relative overflow-hidden"
                     onClick={() => { setSelectedGame(g); setView('details'); }}>
                  
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors"></div>
                  
                  <div className="flex justify-between items-start pl-2">
                    <div>
                      <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
                        {formatDate(g.date) || g.date}
                      </h3>
                      <p className="text-sm font-medium text-emerald-400 mt-1">{g.time}</p>
                      
                      <div className="flex flex-wrap gap-2 mt-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-950/50 px-2.5 py-1 rounded-lg border border-slate-800/50">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                          {g.location}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400/90 bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                          {g.level}
                        </span>
                      </div>
                    </div>
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        let startTime = '';
                        let endTime = '';
                        if (g.time && g.time.includes('-')) {
                          const parts = g.time.split('-');
                          startTime = parseTimeTo24h(parts[0].trim());
                          endTime = parseTimeTo24h(parts[1].trim());
                        }
                        setFormData({...g, startTime, endTime}); 
                        setFormError(''); 
                        setView('form'); 
                      }}
                      className="text-xs font-medium text-slate-500 hover:text-emerald-400 bg-slate-800/50 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700/30 transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- VIEW: DETAILS (Specific Game) ---
  const activePlayers = players.filter((p) => p.status === 'active');
  const waitlisted = players.filter((p) => p.status === 'waitlist');
  const spotsLeft = selectedGame ? selectedGame.max_players - activePlayers.length : 0;
  const isFull = spotsLeft <= 0;

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col items-center p-4 font-sans selection:bg-emerald-500 selection:text-slate-900">
      <div className="w-full max-w-md mt-2 mb-4">
        <button onClick={() => setView('list')} className="flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-emerald-400 transition-colors bg-slate-900/80 px-4 py-2 rounded-xl border border-slate-800 inline-block">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          All Matches
        </button>
      </div>

      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-6 relative overflow-hidden">
        
        <div className={`absolute top-0 left-0 w-full h-1 ${isFull ? 'bg-gradient-to-r from-amber-500 to-orange-400' : 'bg-gradient-to-r from-emerald-400 to-cyan-400'}`}></div>

        {/* Header / Info Section */}
        <div>
          <div className="flex justify-between items-start mb-4">
            <span className={`px-3 py-1.5 text-xs font-bold tracking-wide rounded-lg border ${
              isFull 
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            }`}>
              {isFull ? '🔥 Waitlist Open' : `✨ ${spotsLeft} Spots Available`}
            </span>
          </div>
          
          <h2 className="text-2xl font-extrabold text-white mb-1">{formatDate(selectedGame?.date || '') || selectedGame?.date}</h2>
          <p className="text-sm font-medium text-slate-400 mb-5 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Booked by <span className="text-slate-200">{selectedGame?.booked_by || 'Unknown'}</span>
          </p>
          
          <div className="grid grid-cols-2 gap-3 mb-2">
            <div className="bg-slate-950/50 border border-slate-800/50 rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Time</span>
              <span className="text-sm font-medium text-slate-200">{selectedGame?.time}</span>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/50 rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Location</span>
              <span className="text-sm font-medium text-slate-200">{selectedGame?.location}</span>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/50 rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Level</span>
              <span className="text-sm font-medium text-slate-200">{selectedGame?.level}</span>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/50 rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Capacity</span>
              <span className="text-sm font-medium text-slate-200">{selectedGame?.max_players} Players</span>
            </div>
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-700 to-transparent opacity-50"></div>

        {/* Players Roster */}
        <div>
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Active Roster</h3>
            <span className="text-xs font-medium text-slate-500 bg-slate-950 px-2 py-0.5 rounded-full">{activePlayers.length} / {selectedGame?.max_players}</span>
          </div>
          
          <ol className="space-y-2.5">
            {activePlayers.map((player, idx) => (
              <li key={player.id} className="flex justify-between items-center bg-slate-950/80 px-4 py-3 rounded-xl border border-slate-800/60 shadow-sm">
                <div className="flex items-center gap-3">
                  <span className="w-5 text-center text-xs font-bold text-slate-600">{idx + 1}</span>
                  <span className={`text-sm font-semibold ${player.is_tentative ? 'text-slate-400 italic' : 'text-slate-200'}`}>
                    {player.name}
                  </span>
                </div>
                {player.is_tentative && (
                  <span className="text-[10px] font-bold tracking-wider bg-slate-800/80 text-slate-400 px-2.5 py-1 rounded-md border border-slate-700/50">TENTATIVE</span>
                )}
              </li>
            ))}
            
            {/* Empty slots placeholders */}
            {Array.from({ length: Math.max(0, (selectedGame?.max_players || 0) - activePlayers.length) }).map((_, i) => (
              <li key={`empty-${i}`} className="flex items-center gap-3 bg-slate-950/30 px-4 py-3 rounded-xl border border-slate-800/30 border-dashed">
                <span className="w-5 text-center text-xs font-bold text-slate-700">{activePlayers.length + i + 1}</span>
                <span className="text-sm font-medium text-slate-600 italic">Available Spot</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Waitlist Section */}
        <div>
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
            Waitlist
            {waitlisted.length > 0 && <span className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0.5 rounded-md border border-amber-500/20">{waitlisted.length}</span>}
          </h3>
          {waitlisted.length === 0 ? (
            <div className="bg-slate-950/30 border border-slate-800/30 rounded-xl p-4 text-center">
              <p className="text-xs font-medium italic text-slate-500">Empty — slots will cascade automatically.</p>
            </div>
          ) : (
            <ol className="space-y-2">
              {waitlisted.map((player, idx) => (
                <li key={player.id} className="flex items-center gap-3 bg-slate-950 px-4 py-3 rounded-xl border border-slate-800/40 opacity-80">
                  <span className="w-5 text-center text-xs font-bold text-slate-600">{idx + 1}</span>
                  <span className="text-sm font-medium text-slate-400">{player.name}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-700 to-transparent opacity-50"></div>

        {/* Join Actions Form */}
        <form onSubmit={handleJoin} className="bg-slate-950/50 p-4 rounded-2xl border border-slate-800/50 space-y-4">
          <div>
            <input
              type="text"
              required
              placeholder="Enter your name to join..."
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all placeholder:text-slate-500"
            />
          </div>
          
          <label className="flex items-center gap-3 text-sm font-medium text-slate-400 cursor-pointer select-none group w-max">
            <div className={`w-5 h-5 rounded-md flex items-center justify-center border transition-all ${isTentativeInput ? 'bg-emerald-500 border-emerald-500' : 'bg-slate-900 border-slate-600 group-hover:border-slate-400'}`}>
              {isTentativeInput && <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
            </div>
            <input 
              type="checkbox" 
              checked={isTentativeInput}
              onChange={(e) => setIsTentativeInput(e.target.checked)}
              className="hidden"
            />
            Mark as tentative
          </label>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <button
              type="submit"
              className={`w-full font-bold text-xs py-3.5 rounded-xl transition-all shadow-lg active:scale-[0.98] ${
                !isFull 
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 shadow-emerald-500/20' 
                  : 'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-500 text-slate-950 shadow-amber-500/20'
              }`}
            >
              {!isFull ? '🔒 Secure Slot' : '⏳ Join Waitlist'}
            </button>
            
            <button
              type="button"
              onClick={copyToClipboard}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs py-3.5 rounded-xl border border-slate-700 transition-all active:scale-[0.98] flex items-center justify-center gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              WhatsApp
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './lib/supabase';
import { api } from './lib/api';
import { Layout } from './components/Layout';
import { ErrorBox, Loading, Button } from './components/ui';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Market from './pages/Market';
import Chart from './pages/Chart';
import Signals from './pages/Signals';
import Paper from './pages/Paper';
import History from './pages/History';
import Strategy from './pages/Strategy';
import System from './pages/System';
import Settings from './pages/Settings';

export interface Me { email: string; role: 'admin' | 'viewer' }

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    getSupabase()
      .then(async (sb) => {
        const { data } = await sb.auth.getSession();
        setSession(data.session);
        const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
        unsub = () => sub.subscription.unsubscribe();
      })
      .catch((e) => { setError(String(e)); setSession(null); });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (!session) { setMe(null); return; }
    api<Me>('/api/me').then((m) => { setMe(m); setError(null); }).catch((e) => setError(e.message));
  }, [session?.access_token]);

  const logout = async () => { (await getSupabase()).auth.signOut(); };

  if (session === undefined) return <Loading />;
  if (!session) return <Login initialError={error} />;
  if (!me) {
    return (
      <div className="mx-auto mt-24 max-w-md space-y-4 p-6">
        {error ? <ErrorBox error={error === 'not_authorized' ? `Akun ${session.user.email} belum terdaftar di app_users. Minta administrator menambahkan email Anda.` : error} /> : <Loading />}
        {error && <Button onClick={logout}>Keluar</Button>}
      </div>
    );
  }
  const isAdmin = me.role === 'admin';
  return (
    <Layout email={me.email} role={me.role} onLogout={logout}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/market" element={<Market />} />
        <Route path="/chart" element={<Chart />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/paper" element={<Paper isAdmin={isAdmin} />} />
        <Route path="/history" element={<History />} />
        <Route path="/strategy" element={<Strategy isAdmin={isAdmin} />} />
        <Route path="/system" element={<System isAdmin={isAdmin} />} />
        <Route path="/settings" element={<Settings isAdmin={isAdmin} me={me} />} />
        <Route path="*" element={<Overview />} />
      </Routes>
    </Layout>
  );
}

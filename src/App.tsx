import { lazy, Suspense, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './lib/supabase';
import { api } from './lib/api';
import { Layout } from './components/Layout';
import { ErrorBox, Loading, Button, PageSkeleton } from './components/ui';
import Login from './pages/Login';

// Dashboard pages are code-split: lightweight-charts and page code load only after login.
const Overview = lazy(() => import('./pages/Overview'));
const Market = lazy(() => import('./pages/Market'));
const Chart = lazy(() => import('./pages/Chart'));
const Signals = lazy(() => import('./pages/Signals'));
const Paper = lazy(() => import('./pages/Paper'));
const History = lazy(() => import('./pages/History'));
const Strategy = lazy(() => import('./pages/Strategy'));
const System = lazy(() => import('./pages/System'));
const Settings = lazy(() => import('./pages/Settings'));

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

  if (session === undefined) return <div className="mx-auto max-w-6xl p-4 sm:p-6"><PageSkeleton /></div>;
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
      <Suspense fallback={<PageSkeleton />}>
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
      </Suspense>
    </Layout>
  );
}

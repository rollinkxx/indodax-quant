import { useState, type FormEvent } from 'react';
import { getSupabase } from '../lib/supabase';
import { Button, ErrorBox } from '../components/ui';

export default function Login({ initialError }: { initialError?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const magic = async () => {
    if (!email) { setError('Isi email terlebih dahulu'); return; }
    setBusy(true); setError(null);
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
      if (error) throw error;
      setInfo('Link login telah dikirim ke email Anda.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <div>
          <div className="text-xl font-bold">INDODAX <span className="text-emerald-400">QUANT</span></div>
          <p className="mt-1 text-sm text-slate-400">Masuk dengan akun Supabase Auth Anda.</p>
        </div>
        <ErrorBox error={error} />
        {info && <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{info}</div>}
        <label className="block text-sm">
          <span className="text-slate-400">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
        </label>
        <label className="block text-sm">
          <span className="text-slate-400">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !password} className="w-full">Masuk</Button>
        <Button onClick={magic} disabled={busy} className="w-full">Kirim magic link</Button>
        <p className="text-xs text-slate-500">Hanya email yang terdaftar di tabel <code>app_users</code> yang dapat mengakses dashboard.</p>
      </form>
    </div>
  );
}

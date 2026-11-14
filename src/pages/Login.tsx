import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { getSupabase } from '../lib/supabase';
import { Button, ErrorBox } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';

/** Centered card used by the login screen and the not-authorised screen. Scrolls on short screens. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 h-80 w-[40rem] max-w-[150vw] -translate-x-1/2 -translate-y-1/3 rounded-full bg-accent-soft blur-3xl" />
      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-accent-strong text-accent-fg shadow-card">
            <Icon name="trendUp" className="size-5" />
          </span>
          <div className="mt-3 text-xl font-bold tracking-tight">INDODAX <span className="text-accent">QUANT</span></div>
          <div className="mt-0.5 text-xs text-subtle">Paper trading • simulasi, tanpa order sungguhan</div>
        </div>
        <div className="rounded-card border border-line bg-surface p-6 shadow-card">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, icon, ...input }: { label: string; icon: IconName } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <span className="relative mt-1.5 block">
        <Icon name={icon} className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <input {...input}
          className="h-10 w-full rounded-control border border-line-strong bg-app pl-9 pr-3 text-fg transition-colors placeholder:text-subtle hover:border-slate-600 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent" />
      </span>
    </label>
  );
}

export default function Login({ initialError }: { initialError?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'password' | 'magic' | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('password'); setError(null); setInfo(null);
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const magic = async () => {
    if (!email) { setError('Isi email terlebih dahulu'); return; }
    setBusy('magic'); setError(null); setInfo(null);
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
      if (error) throw error;
      setInfo('Link login telah dikirim ke email Anda.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthScreen>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Masuk</h1>
          <p className="mt-0.5 text-sm text-muted">Gunakan akun Supabase Auth Anda.</p>
        </div>
        <ErrorBox error={error} />
        {info && (
          <div role="status" className="flex animate-fade-in items-start gap-2 rounded-control border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">
            <Icon name="check" className="mt-0.5 size-4 text-emerald-300" /><span>{info}</span>
          </div>
        )}
        <Field label="Email" icon="mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="nama@email.com" />
        <Field label="Password" icon="lock" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="••••••••" />
        <Button type="submit" variant="primary" disabled={!!busy || !password} loading={busy === 'password'} className="h-10 w-full">Masuk</Button>
        <div className="flex items-center gap-3 text-xs text-subtle"><span className="h-px flex-1 bg-line" />atau<span className="h-px flex-1 bg-line" /></div>
        <Button onClick={magic} disabled={!!busy} loading={busy === 'magic'} className="h-10 w-full"><Icon name="mail" className="size-4" />Kirim magic link</Button>
        <p className="text-center text-xs leading-5 text-subtle">Hanya email yang terdaftar di tabel <code className="rounded bg-elevated px-1 py-0.5 text-muted">app_users</code> yang dapat mengakses dashboard.</p>
      </form>
    </AuthScreen>
  );
}

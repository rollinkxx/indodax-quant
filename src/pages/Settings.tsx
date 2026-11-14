import { useState, type ReactNode } from 'react';
import { usePoll } from '../lib/usePoll';
import { post } from '../lib/api';
import { Badge, Button, ErrorBox, PageHeader } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import Market from './Market';
import type { Me } from '../App';

function Panel({ icon, title, desc, children }: { icon: IconName; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"><Icon name={icon} className="size-4" /></span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted">{desc}</p>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-3 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 border-b border-line/60 pb-2 last:border-0 last:pb-0">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export default function Settings({ isAdmin, me }: { isAdmin: boolean; me: Me }) {
  const sys = usePoll<any>('/api/system?limit=1', 60000);
  const health = usePoll<any>('/api/health', 60000);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const testTelegram = async () => {
    setMsg(null); setErr(null); setBusy(true);
    try { await post('/api/telegram/test'); setMsg('Pesan tes terkirim ke Telegram.'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Akun, notifikasi, dan pair yang dipantau" />
      <ErrorBox error={err ?? sys.error} />
      {msg && <div role="status" className="flex items-center gap-2 rounded-card border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200"><Icon name="check" className="size-4 shrink-0" />{msg}</div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel icon="user" title="Akun" desc="Sesi login Supabase Anda.">
          <Row label="Email"><span title={me.email}>{me.email}</span></Row>
          <Row label="Peran"><Badge color={me.role === 'admin' ? 'blue' : 'gray'}>{me.role}</Badge></Row>
          <Row label="Zona waktu">Asia/Jakarta (WIB)</Row>
        </Panel>
        <Panel icon="mail" title="Telegram" desc="Notifikasi sinyal, order, dan perubahan universe.">
          <Row label="Status"><Badge color={sys.data?.telegramConfigured ? 'green' : 'yellow'}>{sys.data?.telegramConfigured ? 'terkonfigurasi' : 'belum diatur'}</Badge></Row>
          <p className="text-xs text-subtle">Token bot dan chat id disimpan sebagai Worker secret (<code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_CHAT_ID</code>), tidak pernah dikirim ke browser.</p>
          {isAdmin && <div className="mt-auto"><Button loading={busy} onClick={testTelegram}><Icon name="mail" className="size-4" />Kirim pesan tes</Button></div>}
        </Panel>
        <Panel icon="shield" title="Keamanan" desc="Mode simulasi dan kunci di sisi server.">
          <Row label="Live trading"><Badge color="gray">{health.data?.liveTrading === false ? 'NONAKTIF' : '—'}</Badge></Row>
          <Row label="Service role di Worker"><Badge color={sys.data?.serviceRoleConfigured ? 'green' : 'red'}>{sys.data?.serviceRoleConfigured ? 'ada' : 'hilang'}</Badge></Row>
          <p className="text-xs text-subtle">Aplikasi hanya memakai API publik INDODAX. Tidak ada API key trading dan tidak ada order sungguhan.</p>
        </Panel>
      </div>
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><Icon name="market" className="size-4" />Kelola pair yang dipantau</h2>
        <Market isAdmin={isAdmin} />
      </div>
    </div>
  );
}

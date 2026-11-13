import { useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { post } from '../lib/api';
import { Badge, Button, Card, ErrorBox, PageHeader } from '../components/ui';
import Market from './Market';
import type { Me } from '../App';

export default function Settings({ isAdmin, me }: { isAdmin: boolean; me: Me }) {
  const sys = usePoll<any>('/api/system?limit=1', 60000);
  const health = usePoll<any>('/api/health', 60000);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const testTelegram = async () => {
    setMsg(null); setErr(null);
    try { await post('/api/telegram/test'); setMsg('Pesan tes terkirim ke Telegram.'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Akun, notifikasi, dan pair yang dipantau" />
      <ErrorBox error={err ?? sys.error} />
      {msg && <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{msg}</div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Akun">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-400">Email</span><span>{me.email}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Peran</span><Badge color={me.role === 'admin' ? 'blue' : 'gray'}>{me.role}</Badge></div>
            <div className="flex justify-between"><span className="text-slate-400">Zona waktu</span><span>Asia/Jakarta (WIB)</span></div>
          </div>
        </Card>
        <Card title="Telegram">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-slate-400">Status</span><Badge color={sys.data?.telegramConfigured ? 'green' : 'yellow'}>{sys.data?.telegramConfigured ? 'terkonfigurasi' : 'belum diatur'}</Badge></div>
            <p className="text-xs text-slate-500">Token bot dan chat id disimpan sebagai Worker secret (<code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_CHAT_ID</code>), tidak pernah dikirim ke browser.</p>
            {isAdmin && <Button onClick={testTelegram}>Kirim pesan tes</Button>}
          </div>
        </Card>
        <Card title="Keamanan">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-400">Live trading</span><Badge color="gray">{health.data?.liveTrading === false ? 'NONAKTIF' : '—'}</Badge></div>
            <div className="flex justify-between"><span className="text-slate-400">Service role di Worker</span><Badge color={sys.data?.serviceRoleConfigured ? 'green' : 'red'}>{sys.data?.serviceRoleConfigured ? 'ada' : 'hilang'}</Badge></div>
            <p className="text-xs text-slate-500">Aplikasi hanya memakai API publik INDODAX. Tidak ada API key trading dan tidak ada order sungguhan.</p>
          </div>
        </Card>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Kelola pair yang dipantau</h2>
        <Market isAdmin={isAdmin} />
      </div>
    </div>
  );
}

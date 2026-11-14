export interface KillSwitchResult {
  status?: string;
  closed?: number;
  total?: number;
  results?: Array<{
    pair?: string;
    ok?: boolean;
    error?: string;
    reason?: string;
  }>;
}

export interface KillSwitchOutcome {
  msg: string;
  err: string | null;
}

/** Summarize account kill status separately from whether every open position closed. */
export function killSwitchOutcome(result: KillSwitchResult): KillSwitchOutcome {
  const closed = Number.isFinite(result.closed) ? Math.max(0, Number(result.closed)) : 0;
  const total = Number.isFinite(result.total) ? Math.max(0, Number(result.total)) : 0;
  const msg = `Kill switch aktif: ${closed}/${total} posisi berhasil ditutup.`;
  if (closed >= total) return { msg, err: null };

  const failed = (result.results ?? [])
    .filter((position) => position.ok !== true)
    .map((position) => {
      const pair = position.pair || 'posisi tidak dikenal';
      const reason = position.error || position.reason || 'gagal ditutup';
      return `${pair}: ${reason}`;
    });
  const detail = failed.length ? ` Detail: ${failed.join('; ')}.` : '';
  const remaining = total - closed;
  return {
    msg,
    err: `Perhatian: ${remaining} posisi belum tertutup.${detail} Akun tetap KILLED; periksa harga pasar dan coba tutup posisi yang tersisa secara aman.`,
  };
}

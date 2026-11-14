export type HistoryPeriod = '1' | '7' | '30' | 'all';

/** Explains retained transaction history versus current-session account metrics. */
export function historyScopeNote(period: HistoryPeriod): string {
  const scope = period === 'all'
    ? 'seluruh riwayat transaksi tersimpan'
    : 'transaksi dalam rentang waktu terpilih';
  return `Ringkasan PnL menghitung ${scope} dan dapat mencakup transaksi sebelum reset akun. Reset akun tidak menghapus riwayat transaksi; metrik Overview/Paper dimulai ulang sejak reset terakhir.`;
}

import fs from 'node:fs';

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`Missing evaluation input: ${path}`);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
function value(value, fallback = 0) {
  return value === null || value === undefined ? fallback : value;
}
function money(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

const backtest = readJson('artifacts/backtest.json');
const paper = readJson('artifacts/paper-report.json');
const experiment = backtest.experiment || {};
const lines = [
  '## Strategy evaluation (read-only)',
  '',
  '- Control: crossLookback=2.',
  '- Variant: crossLookback=4 (only changed parameter).',
  '- MTF: ' + (experiment.mtf || 'n/a') + '.',
  '- Holdout: chronological final 30% per pair.',
  '- No order or paper-account mutation is performed by either script.',
  '',
  '### Aggregated holdout (independent per-pair accounts, not a shared portfolio)',
  '',
  '| Variant | Trades | Win rate | Profit factor | Net PnL | Expectancy | Max drawdown | End-of-data exits |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
];

for (const [key, metrics] of Object.entries(backtest.aggregateOutOfSampleIndependentPairAccounts || {})) {
  lines.push(
    '|' + key +
    '|' + String(value(metrics.trades)) +
    '|' + String(value(metrics.winRatePct)) + '%' +
    '|' + String(value(metrics.profitFactor, 'n/a')) +
    '|Rp ' + money(metrics.netPnlIdr) +
    '|Rp ' + money(metrics.expectancyIdr) +
    '|' + String(value(metrics.maxDrawdownPct)) + '%' +
    '|' + String(value(metrics.endOfDataExits)) + '|',
  );
}

lines.push(
  '',
  '### Evidence gate (never auto-promotes a strategy)',
  '',
  'Gate on sample size, profit factor and net expectancy. The Wilson 95% win-rate floor is shown for context and is **advisory only** — it does not block.',
  '',
  '| Variant | Decision | Wilson 95% win-rate lower bound (advisory) | Rejection reasons |',
  '|---|---|---:|---|',
);
for (const [key, decision] of Object.entries(backtest.evidenceGateByVariant || {})) {
  const floor = decision.winRateFloorEnforced === true ? ' (enforced)' : ' (advisory)';
  lines.push(
    '|' + key +
    '|' + String(value(decision.status, 'NO_GO')) +
    '|' + String(value(decision.lower95WinRatePct)) + '%' + floor +
    '|' + (Array.isArray(decision.reasons) ? decision.reasons.join(', ') : '') + '|',
  );
}

lines.push(
  '',
  '| Pair | Bars | Official OHLC coverage | Holdout starts | 2: trades / win rate / PF / net PnL | 4: trades / win rate / PF / net PnL |',
  '|---|---:|---:|---|---:|---:|',
);
for (const [pair, result] of Object.entries(backtest.results || {})) {
  const variants = result.variants || {};
  const two = variants.cross_lookback_2?.outOfSampleLast30Pct || {};
  const four = variants.cross_lookback_4?.outOfSampleLast30Pct || {};
  const formatVariant = (metrics) =>
    String(value(metrics.trades)) + ' / ' +
    String(value(metrics.winRatePct)) + '% / ' +
    String(value(metrics.profitFactor, 'n/a')) + ' / Rp ' +
    money(metrics.netPnlIdr);
  const history = result.officialHistory || {};
  const coverage = history.historyCoveragePct == null
    ? 'n/a'
    : String(history.historyCoveragePct) + '% (' +
      String(value(history.complete5mBars)) + '/' +
      String(value(history.expected5mBars)) + ')';
  lines.push(
    '|' + pair + '|' + String(value(result.candles)) + '|' + coverage +
    '|' + String(value(result.holdoutFrom, 'n/a')) +
    '|' + formatVariant(two) + '|' + formatVariant(four) + '|',
  );
}

lines.push(
  '',
  'Pairs evaluated: **' + String(value(experiment.pairsEvaluated)) +
    '** of ' + String(value(experiment.pairsRequested)) + ' requested.',
  'Official history window: **' + String(value(experiment.officialHistoryDaysRequested)) +
    ' days**; complete OHLC 5m bars: **' +
    String(value(experiment.officialHistoryComplete5mBars)) + '/' +
    String(value(experiment.officialHistoryExpected5mBars)) +
    '** (**' + String(value(experiment.officialHistoryCoveragePct)) + '% structural coverage**).',
  'Positive-volume 5m bars: **' +
    String(value(experiment.officialHistoryActiveVolume5mBars)) +
    '** (**' + String(value(experiment.officialHistoryActiveVolumeCoveragePct)) +
    '% of expected bars**); zero-volume 5m bars: **' +
    String(value(experiment.officialHistoryZeroVolume5mBars)) +
    '**; zero-volume 1m bars: **' +
    String(value(experiment.officialHistoryZeroVolume1mBars)) + '**.',
  '',
  '### Paper account since reset',
  '',
  '- Status: **' + String(value(paper.account?.status, 'unknown')) + '**',
  '- Equity: Rp ' + money(paper.account?.equityIdr),
  '- Closed trades: **' + String(value(paper.paperPerformanceSinceReset?.closedTrades)) + '**',
  '- Open positions: **' + String(value(paper.paperPerformanceSinceReset?.openPositions)) + '**',
  '- Realized PnL: Rp ' + money(paper.paperPerformanceSinceReset?.netPnlIdr),
  '',
  '### Backtest scope limitations',
  '',
  ...(Array.isArray(backtest.scopeWarnings) ? backtest.scopeWarnings.map((warning) => '- ' + warning) : []),
  '- Unclosed positions are closed at the final observed candle close with exit slippage and fee; see END_OF_DATA exits in the JSON.',
  '- Aggregated holdout figures combine independent per-pair accounts; they are not a shared-cash portfolio.',
  '- Candle-only per-pair simulation; not production-parity for portfolio-level cash/exposure or MTF execution.',
  '',
  'Full JSON outputs are attached as the strategy-evaluation artifact.',
);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (!summaryPath) throw new Error('GITHUB_STEP_SUMMARY is not set');
fs.appendFileSync(summaryPath, lines.join('\n') + '\n');

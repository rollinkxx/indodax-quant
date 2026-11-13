-- Strategy hardening (forensic audit follow-up). Non-destructive.
-- 1) Allow the new exit reasons on paper_orders.
alter table public.paper_orders drop constraint if exists paper_orders_reason_check;
alter table public.paper_orders add constraint paper_orders_reason_check
  check (reason in ('SIGNAL', 'STOP_LOSS', 'TAKE_PROFIT', 'MANUAL', 'KILL_SWITCH', 'MAX_DRAWDOWN', 'TIME_STOP', 'DAILY_LOSS'));

-- 2) Align the ACTIVE strategy config with the hardened defaults (merge, keeps every other key).
update public.strategy_configs
set params = params || jsonb_build_object(
  'crossLookback', 2,
  'rsiBuyMax', 65,
  'maxEntryExtensionPct', 1.5,
  'sellRequireConfirm', false,
  'maxOpenPositions', 4,
  'maxTotalExposurePct', 60,
  'trailingStopEnabled', true,
  'trailActivationAtr', 1.5,
  'trailDistanceAtr', 1,
  'timeStopMinutes', 720,
  'closeOnDailyLoss', true,
  'dynamicSlippage', true,
  'universeExclude', (
    select coalesce(jsonb_agg(distinct v order by v), '[]'::jsonb)
    from jsonb_array_elements_text(
      coalesce(params->'universeExclude',
        '["usdtidr","usdcidr","busdidr","daiidr","tusdidr","fdusdidr","pyusdidr","usdeidr"]'::jsonb)
      || '["xautidr","paxgidr"]'::jsonb) as t(v)
  )
)
where is_active;

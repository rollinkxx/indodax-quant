-- Entry execution gate (forensic audit 2026-11-13 22:xx WIB). Non-destructive jsonb merge into the ACTIVE strategy config.
-- anoaidr: BUY filled at ask+40bps on a 1.2% spread, bid was already below the ATR stop -> STOP_LOSS 61 s later (-Rp64k).
update public.strategy_configs
set params = params || jsonb_build_object(
  'maxEntrySpreadPct', 0.6,
  'maxEntryDriftPct', 0.5,
  -- below Rp500jt/24h dynamic slippage is x4 and spreads are routinely >1%: keep such pairs out of the universe
  'universeMinVolumeIdr', greatest(coalesce((params->>'universeMinVolumeIdr')::numeric, 0), 500000000)
)
where is_active;

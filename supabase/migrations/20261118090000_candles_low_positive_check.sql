-- Candle integrity: `low` must be a positive price.
-- The existing candle check already enforces high >= open/close and open/close > 0 (so high > 0 is
-- implied), but low had no positivity guard. A malformed feed row with low <= 0 would silently poison
-- ATR, stop distance, and reward/risk downstream. Verified against production before adding: 0 of
-- 216,738 rows violated, so the constraint validates immediately without touching any data.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.candles'::regclass and conname = 'candles_low_positive'
  ) then
    alter table public.candles
      add constraint candles_low_positive check (low > 0);
  end if;
end $$;

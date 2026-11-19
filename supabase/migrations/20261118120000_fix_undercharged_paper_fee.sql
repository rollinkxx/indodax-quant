-- Remove the stale 0.00555%/side fee assumption from the active strategy.
--
-- On 2026-11-16 a migration set feePct = 0.00555 (percentage points) to model a cheap-fee
-- assumption. Between 2026-11-17 and 2026-11-18 nine paper trades were charged that value
-- instead of the real 0.2% INDODAX taker fee: 36x under-charged, Rp86,659 of fees never booked.
-- Because the net reward/risk entry gate reads this same value, 9 of those 15 trades that the
-- gate should have rejected were opened, and the win/loss record was distorted.
--
-- feeModel is already 'pair_taker', so feePct is now only a fallback for a missing catalog
-- value. Keep it at the real taker rate so a fallback can never under-charge again.
UPDATE public.strategy_configs
SET params = jsonb_set(
      jsonb_set(COALESCE(params, '{}'::jsonb), '{feePct}', to_jsonb(0.2::numeric), true),
      '{feeModel}', to_jsonb('pair_taker'::text), true
    ),
    updated_at = now()
WHERE is_active = true;

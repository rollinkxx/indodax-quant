-- Apply the user-requested paper fee-model assumption to the active strategy.
-- feePct is stored as percentage points (0.00555 means 0.00555%, not 0.555%).
-- This version matches the applied Supabase migration record 20261116163134.
UPDATE public.strategy_configs
SET params = jsonb_set(COALESCE(params, '{}'::jsonb), '{feePct}', to_jsonb(0.00555::numeric), true),
    updated_at = now()
WHERE is_active = true;

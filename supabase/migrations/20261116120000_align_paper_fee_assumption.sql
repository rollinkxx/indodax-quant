-- Apply the user-requested maker/taker fee assumption to the active paper strategy.
-- feePct is stored as a percentage (0.00555 means 0.00555%, not 0.555%).
UPDATE public.strategy_configs
SET params = jsonb_set(COALESCE(params, '{}'::jsonb), '{feePct}', to_jsonb(0.00555::numeric), true),
    updated_at = now()
WHERE is_active = true;

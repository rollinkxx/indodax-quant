-- Retract the 5x/9x "win-rate profile" bracket introduced by 20261118160000.
--
-- That migration set takeProfit (5x ATR) closer than stopLoss (9x ATR), i.e. a 0.56 reward/risk
-- ratio, to buy a high hit rate. Win rate is not expectancy: with a 0.56 R:R the strategy needs a
-- ~64% hit rate just to break even before the 0.2% taker fee, and its own header admits the
-- evidence was 24 trades positive in only 2 of 5 walk-forward folds. It also wrote an inverted
-- bracket, which `validateCrossFieldParams` now rejects, so every pipeline run failed closed with
-- INVALID_NET_REWARD_RISK and no entry could ever be taken.
--
-- Restore the engine defaults (1.5x stop / 3x target = 2:1, minNetRewardRiskRatio 1) so the risk
-- bracket is at least mathematically capable of profit. This is NOT a validated edge: the config
-- still has to clear the promotion gate before real money, and paper trading stays the only mode.
--
-- Expected consequence, measured against the stored sample: with a 0.6% round trip (0.2% taker each
-- side + 10 bps slippage each side) the net reward/risk of a 1.5x/3x bracket is 0.385 at the typical
-- ~0.29% ATR, 0.80 at 0.5% ATR and only clears the 1.0 floor above ~0.8% ATR. The economics gate
-- will therefore reject most entries on quiet 5m candles. That is the correct outcome: a bracket
-- whose net reward does not cover its net risk has negative expectancy by construction, so refusing
-- to trade it beats trading it. A config that trades often is not the goal.
UPDATE public.strategy_configs
SET params = COALESCE(params, '{}'::jsonb) || jsonb_build_object(
      'atrStopMultiplier', 1.5,
      'atrTakeProfitMultiplier', 3,
      'minNetRewardRiskRatio', 1,
      'trailingStopEnabled', true,
      'sellRequireConfirm', false,
      'timeStopMinutes', 720
    ),
    updated_at = now()
WHERE is_active = true;

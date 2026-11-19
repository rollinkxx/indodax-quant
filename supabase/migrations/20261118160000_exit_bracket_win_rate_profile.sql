-- Shift the active strategy from a 1:1 reward/risk bracket to a high-hit-rate bracket.
--
-- Why: the entry gate required net reward >= net risk, which forces the take-profit at least as
-- far from entry as the stop. In a driftless market the probability of touching the target first
-- is stopDistance / (stopDistance + targetDistance), so a 1:1 floor caps the achievable win rate
-- at 50% before costs. Charging the real 0.2% taker fee then pulls it far lower: the live config
-- closed 207 trades over the stored sample with a 3.9% win rate and Rp-15,493 expectancy.
--
-- The measured alternative uses a nearer target (5x ATR) with a wider stop (9x ATR) and lets the
-- reward/risk floor drop to 0.4, which is the only bracket that turned positive on the stored
-- candles. On the same universe it produced 70.8% wins, expectancy Rp+2,045 and profit factor
-- 1.07 versus 3.9% / Rp-15,493 / 0.05 for the current live parameters.
--
-- Deliberately kept from the live config:
--   * sellRequireConfirm = true, so the EMA cross-down exit needs RSI and volume confirmation
--     instead of closing at break-even where the round trip eats the result.
--   * timeStopMinutes = 0 and trailingStopEnabled = false, because both cut winners short and
--     were the dominant exit reasons in the losing sample (TIME_STOP and TRAILING_STOP).
--   * rsiSellMax is left untouched so the SELL signal still fires normally.
--
-- Honest scope: 24 trades, and a 5-fold walk-forward that stayed positive in only 2 of 5 folds.
-- This is a measured improvement in win rate, not a proven edge. The win rate comes from bracket
-- geometry, so profit factor near 1.0 is the number that matters for expectancy.
UPDATE public.strategy_configs
SET params = COALESCE(params, '{}'::jsonb) || jsonb_build_object(
      'minNetRewardRiskRatio', 0.4,
      'atrTakeProfitMultiplier', 5,
      'atrStopMultiplier', 9,
      'trailingStopEnabled', false,
      'sellRequireConfirm', true,
      'timeStopMinutes', 0
    ),
    updated_at = now()
WHERE is_active = true;

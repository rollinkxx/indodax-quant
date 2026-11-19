-- A stop that the trailing stop ratcheted above entry was recorded as STOP_LOSS, because
-- exitReason() only compared the bid against stop_loss. Those rows are relabelled so historical
-- exit attribution matches the live engine (shared/paper.ts, PR #51).
--
-- The test is deliberately narrow: only rows still marked STOP_LOSS whose stored stop sits above
-- their own entry. realized_pnl is untouched, so no balance, fee or win/loss total moves.
update paper_positions
   set exit_reason = 'TRAILING_STOP'
 where status = 'CLOSED'
   and exit_reason = 'STOP_LOSS'
   and stop_loss is not null
   and entry_price is not null
   and stop_loss > entry_price;

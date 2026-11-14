-- Add indexes for foreign-key lookup and parent-row delete/update checks.
-- Existing account_id indexes and the partial open-position index are retained.
create index if not exists paper_orders_pair_id_idx
  on public.paper_orders (pair_id);

create index if not exists paper_orders_position_id_idx
  on public.paper_orders (position_id);

create index if not exists paper_orders_signal_id_idx
  on public.paper_orders (signal_id);

create index if not exists paper_positions_entry_signal_id_idx
  on public.paper_positions (entry_signal_id);

create index if not exists paper_positions_pair_id_idx
  on public.paper_positions (pair_id);

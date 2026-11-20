# Third-party skills vendored into `.agents/skills/`

These skills live in `.agents/skills/`. They come from public MIT-licensed
repositories, copied unmodified except for this file and `indodax-engine/` (which is
first-party). Each is a plain `SKILL.md` folder, so OpenHands reads the
name/description first and only loads the body and `references/`, `scripts/` on demand.

| Skill | Upstream | Pinned commit | License |
| --- | --- | --- | --- |
| `backtest-expert` | [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) | `f95e770591b56fd83b9917175f5a7e8fe9ac47dc` | MIT (c) 2026 TraderMonty — `licenses/tradermonty-MIT.md` |
| `walk-forward-validation` | [agiprolabs/claude-trading-skills](https://github.com/agiprolabs/claude-trading-skills) | `981e1d736cdc02bdc1c55c74ec9224e956414706` | MIT (c) 2026 AGIPro — `licenses/agiprolabs-MIT.md` |
| `exit-strategies` | agiprolabs/claude-trading-skills | same | MIT |
| `position-sizing` | agiprolabs/claude-trading-skills | same | MIT |
| `risk-management` | agiprolabs/claude-trading-skills | same | MIT |
| `ohlcv-processing` | agiprolabs/claude-trading-skills | same | MIT |
| `regime-detection` | agiprolabs/claude-trading-skills | same | MIT |
| `portfolio-analytics` | agiprolabs/claude-trading-skills | same | MIT |
| `volatility-modeling` | agiprolabs/claude-trading-skills | same | MIT |
| `mean-reversion` | agiprolabs/claude-trading-skills | same | MIT |
| `cointegration-analysis` | agiprolabs/claude-trading-skills | same | MIT |
| `market-microstructure-traditional` | agiprolabs/claude-trading-skills | same | MIT |

## Review performed before vendoring

- Frontmatter `name` matches the directory name for every skill (checked).
- No lifecycle hooks, no `postinstall`, no CI workflows, no `.git` directory shipped.
- Bundled Python is read-only analysis code (`numpy`/`pandas`/`scipy`); no code
  executes on install and nothing is imported by the app, the Worker, or the test
  suite.
- Grepped for prompt-injection and exfiltration patterns (instruction override,
  `~/.ssh`, `id_rsa`, webhook/pastebin POST, credential env reads): no matches.
- `regime-detection/scripts/detect_regime.py`,
  `ohlcv-processing/scripts/process_ohlcv.py`, `volatility-modeling/scripts/vol_forecast.py`
  and `mean-reversion/scripts/mean_reversion_test.py` contain an **optional** live-data
  path that reads `BIRDEYE_API_KEY` and calls Birdeye (Solana). That path is irrelevant
  here: this repo is INDODAX IDR spot pairs and has no Birdeye access. Use the offline
  paths only, or the repo's own `npm run alpha:research` / `npm run backtest`.
- `market-microstructure-traditional` and `cointegration-analysis` have no network path
  and no key handling at all.
- Rejected on relevance, not safety: `market-microstructure` and `slippage-modeling`
  (both assume AMM/Solana DEX mechanics, this repo is a CEX order-book spot market) and
  `custom-indicators` (on-chain NVT/exchange-flow metrics that need data this repo does
  not ingest).

## Applying them here

The skills are generic (US equities / Solana phrasing in places). Where they
disagree with this repository, the repository wins — see `indodax-engine/SKILL.md`
and `AGENTS.md`. In particular: paper trading only, 0.2%/side taker fees, and the
backtest's documented scope limits.

## Updating

Re-copy the folder from a newer upstream commit, re-run the review above, and bump
the pinned commit in this table. Do not edit vendored `SKILL.md` files in place:
local guidance belongs in `indodax-engine/`.

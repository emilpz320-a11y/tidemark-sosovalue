# Changelog

## Wave 3 (Build Phase II): first public release, 0.3.0

Tidemark joins the buildathon in Wave 3, so this wave covers the whole product: concept, build and polish.

### Added
- **Data layer**: SoSoValue OpenAPI client covering ETF flow history, coin and SSI index snapshots, sector spotlight, the news feed, hot news, the macro calendar, FOMC probabilities and the market overview. It has timeouts and retries, and each source fails on its own without stopping the run.
- **Signal engine**: five explainable factors (ETF flows, momentum, sector breadth, news sentiment, regime) combined into BUY/SELL/HOLD. Confidence rewards agreement between factors and is cut by macro risk.
- **Risk engine**: 1% risk budget, volatility-based stops, per-position and gross exposure caps, plus guards for spot shorts, missing venues, macro storms and stale data.
- **Execution planner**: walks live SoDEX spot and perps order books to estimate fill price, spread, slippage and fill ratio. Tickets are confirm-before-send and blocked when slippage is above 30 bps or the book is too thin.
- **Explainer**: a plain-English summary, drivers and "what would change the view" for every asset, plus a desk brief.
- **Paper track record**: marks every proposed ticket to the current SoDEX price on each run.
- **Dashboard** (GitHub Pages): desk brief, tickets with Confirm (paper) and Reject, signal cards with factor bars, news evidence and score history, the track record, a personal paper blotter and the risk panel. Works on mobile and in light or dark mode.
- **Automation**: a GitHub Actions job runs the tests and the agent every 6 hours and publishes the snapshot. A separate CI workflow runs the tests on every push.
- 21 unit tests (`node:test`) covering factors, composite logic, sizing, guards, the order-book walk, ticket blocking, the ledger and the explainer.

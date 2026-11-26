# Changelog

## Wave 3 update (26 Nov 2026): signed SoDEX execution, 0.4.0

### Added
- **SoDEX order signer** (`src/sodex-signer.mjs`): builds spot (`batchNewOrder`) and perps (`newOrder`) requests from a confirmed ticket with the exchange filters applied (tick, step, min quantity, min notional, symbol status), and signs them with EIP-712 `ExchangeAction` under the `spot`/`futures` domains (testnet chainId 138565). The `0x01`-typed signature is recovered and checked before sending.
- **Confirm-before-send CLI** (`npm run execute`): previews by default; `--send` needs the ticket id repeated with `--confirm` and the user's own testnet API key. Only `AWAITING_CONFIRMATION` tickets can be signed; mainnet is refused.
- **Signed order on the dashboard**: every agent run signs the top ticket with a throwaway key and publishes the request (endpoint, body, EIP-712 domain, payloadHash, signature check) in a new "Signed SoDEX order (testnet)" panel. It is never sent.
- 8 new tests (29 in total): rounding without float noise, Go-struct field order for spot and perps, refusal of blocked/halted/too-small tickets, payloadHash, signature recovery, determinism, client order ids.

### Changed
- Workflows install dependencies with `npm ci` (new dependency: `viem`).

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

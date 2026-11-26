# Tidemark: an agentic rotation desk on SoSoValue

**Live demo:** https://emilpz320-a11y.github.io/tidemark-sosovalue/ (refreshed every 6 hours by GitHub Actions)

Tidemark is a one-person crypto desk run by an agent. It reads SoSoValue's market data, scores
majors and SSI sector indices, explains every call with the evidence behind it, and turns
the actionable ones into order tickets **priced against live SoDEX order books**. A human
confirms each ticket before anything happens. The demo never signs or sends orders.

> Built for the SoSoValue Buildathon on AKINDO (Wave 3: product completion, risk control, final demo).

## What a user gets

| Panel | What it answers |
|---|---|
| **Desk brief** | "What should I do today, and why?" Regime, macro calendar, the top idea and how many tickets are ready. |
| **Tickets awaiting confirmation** | Side, size, estimated fill, spread and slippage from the live SoDEX book, stop and max loss. *Confirm (paper)* or *Reject*. |
| **Signals** | One card per asset: stance, composite score, confidence, factor bars, a plain-English explanation, the guard that blocked it (if any), score history and the news that moved it, with links. |
| **Paper track record** | Every ticket the agent proposed, marked to the current SoDEX price: P&L, hit rate, stop-outs. |
| **Your paper blotter** | The tickets *you* confirmed on this device. |
| **Macro & risk guardrails** | Macro risk meter, next FOMC odds, sizing rules and execution limits. |

## Pipeline

```
SoSoValue API ──► factors ──► composite signal ──► risk engine ──► SoDEX book walk ──► ticket (AWAITING_CONFIRMATION)
   ETF flows        flow         BUY/SELL/HOLD       1% risk budget    spread, slippage     human confirms
   snapshots        momentum     confidence =         vol-based stop    fill ratio           paper ledger marks it
   sector spotlight sector       |score| × agreement  position & gross  ≤30 bps, ≥98% fill   to market every run
   news feed        news         × coverage           caps, no spot
   macro, FOMC      regime       × (1 − macro risk)   shorts
```

### Data used (SoSoValue OpenAPI, `x-soso-api-key`)

| Endpoint | Used for |
|---|---|
| `/v1/etfs/summary-history?symbol=BTC|ETH|SOL` | 5-day net flow vs typical daily flow, inflow/outflow streak |
| `/v1/currencies`, `/v1/currencies/{id}/market-snapshot` | Coin momentum (24h change, position in the daily range, daily range for stops) |
| `/v1/indices`, `/v1/indices/{ticker}/market-snapshot` | SSI index momentum (24h, 7d, 30d returns) |
| `/v1/currencies/sector-spotlight` | Sector breadth: rank and spread vs the median sector |
| `/v1/news?currency_id=…`, `/v1/news/hot` | Recency-weighted news sentiment with linked evidence |
| `/v1/macro/events`, `/v1/macro/fomc-probabilities` | Macro risk (high-impact releases in 48h, FOMC certainty) |
| `/v1/market/overview` | Market regime (total market cap change) |

About 21 calls per run, well inside the free tier (10,000 per month, 100 per minute).

### Execution venue (SoDEX, public read-only endpoints)

* Majors map to SoDEX perps (`BTC-USD`, `ETH-USD`, `SOL-USD`), so the desk can lean short.
* SSI indices map to the SoSoValue SSI spot tokens on SoDEX (`vMAG7ssi_vUSDC`, `vDEFIssi_vUSDC`, `vMEMEssi_vUSDC`). Spot cannot be shorted, so SELL calls there become "reduce holdings" and are blocked as new tickets.
* `GET /api/v1/{spot|perps}/markets/{symbol}/orderbook` is walked level by level to estimate average fill, slippage vs mid and fill ratio.
* `GET /api/v1/{spot|perps}/markets/tickers` marks past tickets for the track record.

### Signed execution (SoDEX testnet)

`src/sodex-signer.mjs` turns a confirmed ticket into the exact request SoDEX expects, and `src/execute.mjs` is the confirm-before-send CLI around it.

* **Order:** LIMIT IOC at the ticket's worst book level, so it can never fill worse than the price shown. Price is rounded to the symbol's `tickSize` (up for buys, down for sells) and quantity down to `stepSize`; `minQuantity`, `minNotional` and `status == TRADING` are checked against `GET /api/v1/{spot|perps}/markets/symbols` first.
* **Body:** spot `POST /api/v1/spot/trade/orders/batch` (`{accountID, orders:[{symbolID, clOrdID, side, type, timeInForce, price, quantity}]}`); perps `POST /api/v1/perps/trade/orders` (`{accountID, symbolID, orders:[{clOrdID, modifier, side, type, timeInForce, price, quantity, reduceOnly, positionSide}]}`). Keys follow the Go struct order and decimals are strings, because the server re-marshals the body to verify the hash.
* **Signature:** `payloadHash = keccak256(JSON of {type:"batchNewOrder"|"newOrder", params})`, EIP-712 `ExchangeAction{payloadHash, nonce}` under domain `spot`/`futures`, version 1, chainId 138565 (testnet). `X-API-Sign = 0x01 ‖ signature`, `X-API-Nonce` = ms timestamp, `X-API-Key` = the API key's name. The signer is recovered and compared before anything leaves the machine.
* **Confirmation:** only `AWAITING_CONFIRMATION` tickets can be signed; `--send` also needs `--confirm <ticketId>` repeated and your own testnet API key in the environment. The tool refuses mainnet.
* **Every run:** the workflow signs the top ticket with a throwaway key and publishes it as `docs/data/execution.json` (shown on the dashboard). It is never sent.

```bash
npm run execute                                   # signed preview of the top ticket (never sent)
SODEX_API_KEY_PRIVATE_KEY=0x... SODEX_API_KEY_NAME=tidemark-01 SODEX_ACCOUNT_ID=123   npm run execute -- --ticket tm-8ebf2738 --confirm tm-8ebf2738 --send   # testnet only
```

## Risk controls

* **Sizing:** risk 1% of a $10,000 paper account per idea, scaled by confidence and macro risk. Stop = 1.5× the daily range, clamped to 2–12%.
* **Caps:** max 20% of equity per position, 60% gross across the run.
* **Guards:** no ticket without a SoDEX market, no shorts on spot, no new longs when macro risk > 75%, stale data refused.
* **Execution limits:** slippage ≤ 30 bps and ≥ 98% of size fillable, or the ticket is blocked with the reason shown.
* **Human in the loop:** tickets are `AWAITING_CONFIRMATION`. Signing for real needs the ticket id typed twice and the user's own testnet API key; the scheduled agent only ever signs previews with a throwaway key and holds no SoDEX keys.

## How signals are scored

Each factor is in [−1, 1] and carries its own evidence string:

* **ETF flows** `tanh(5-day net flow / (5 × mean |daily flow|))`
* **Momentum** (coins) `0.6·tanh(24h/3%) + 0.4·range position`; (indices) `0.2·tanh(24h/3%) + 0.4·tanh(7d/10%) + 0.4·tanh(30d/20%)`
* **Sector** `tanh((sector 24h − median sector 24h) / 2%)`
* **News** lexicon sentiment with negation handling. The title counts double and each article's weight halves every 24h.
* **Regime** market cap change, BTC ETF flow and macro risk

Weights: majors use flow 35%, momentum 30%, news 25%, regime 10%. Indices use momentum 45%, sector 25%, news 15%, regime 15%.
Confidence = `min(1, 1.6·|score|) × (0.4 + 0.6·agreement) × coverage × (1 − 0.5·macro risk)`, where
*agreement* is the share of live factors that point the same way as the composite. BUY or SELL needs |score| ≥ 0.2 and confidence ≥ 0.2.

## Run it

```bash
npm ci && npm test              # 29 unit tests, no network
echo "SOSO_API_KEY=..." > .env  # free key: https://sosovalue.com/developer/dashboard
node src/run.mjs               # writes docs/data/latest.json and history.json
python -m http.server -d docs  # open http://localhost:8000
```

Node ≥ 20; one dependency (`viem`, for EIP-712 signing). In CI the key is the `SOSO_API_KEY` repository secret. `.github/workflows/agent.yml`
runs the agent every 6 hours and commits the snapshot that GitHub Pages serves.

## Layout

```
src/clients.mjs    SoSoValue + SoDEX HTTP clients (timeouts, retries)
src/signals.mjs    pure factor functions and the composite signal
src/risk.mjs       position sizing and guards
src/execution.mjs  order-book walk, slippage, confirm-before-send tickets
src/sodex-signer.mjs  SoDEX order builder + EIP-712 signer (spot and perps)
src/execute.mjs    confirm-before-send CLI: preview or send a signed order to SoDEX testnet
src/explain.mjs    deterministic plain-English explanations and the desk brief
src/ledger.mjs     paper track record (mark-to-market of past tickets)
src/run.mjs        orchestration
docs/              static dashboard (GitHub Pages)
test/              node:test suite
```

## Limits

* The paper track record only sees prices at run times, so a stop hit between runs can be missed.
* The news sentiment is a transparent lexicon, not a language model. It is auditable but can misread sarcasm or mixed headlines.
* This is a research tool and not financial advice.

See [CHANGELOG.md](CHANGELOG.md) for what changed in this wave.

MIT licensed.

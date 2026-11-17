import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etfFlowFactor, coinMomentumFactor, indexMomentumFactor, sectorFactor, headlineSentiment,
  newsFactor, macroRisk, compositeSignal, regimeFactor,
} from '../src/signals.mjs';
import { sizePositions, stopDistance, DEFAULT_RISK } from '../src/risk.mjs';
import { simulateFill, buildTicket } from '../src/execution.mjs';
import { markToMarket } from '../src/ledger.mjs';
import { explainAsset, deskBrief } from '../src/explain.mjs';

const NOW = Date.parse('2026-11-17T06:00:00Z');
const days = (n, f) => Array.from({ length: n }, (_, i) => ({
  date: new Date(NOW - (i + 1) * 864e5).toISOString().slice(0, 10),
  total_net_inflow: f(i),
  total_net_assets: 9e10,
}));

test('ETF flow factor: persistent outflows give a negative score and a negative streak', () => {
  const f = etfFlowFactor(days(30, (i) => (i < 7 ? -2e8 : 1e8)));
  assert.ok(f.score < -0.5);
  assert.equal(f.streak, -7);
  assert.equal(f.last5d, -1e9);
});

test('ETF flow factor: too little history is reported as unavailable, not as zero evidence', () => {
  const f = etfFlowFactor(days(3, () => 1e8));
  assert.equal(f.available, false);
  assert.equal(f.score, 0);
});

test('coin momentum: price at the top of the range with a gain is positive', () => {
  const f = coinMomentumFactor({ price: 110, high_24h: 110, low_24h: 100, change_pct_24h: 0.04 });
  assert.ok(f.score > 0.8);
  assert.equal(f.rangePosition, 1);
});

test('index momentum blends 24h, 7d and 30d returns', () => {
  const up = indexMomentumFactor({ price: 1, change_pct_24h: 0.02, roi_7d: 0.1, roi_1m: 0.2 });
  const down = indexMomentumFactor({ price: 1, change_pct_24h: -0.02, roi_7d: -0.1, roi_1m: -0.2 });
  assert.ok(up.score > 0.5 && down.score < -0.5);
  assert.equal(up.score, -down.score);
});

test('sector factor ranks the sector against the median', () => {
  const spot = { sector: [
    { name: 'DeFi', change_pct_24h: 0.05 }, { name: 'AI', change_pct_24h: 0.0 },
    { name: 'Meme', change_pct_24h: -0.01 }, { name: 'RWA', change_pct_24h: -0.04 },
  ] };
  const defi = sectorFactor(spot, 'defi');
  assert.equal(defi.rank, 1);
  assert.ok(defi.score > 0.9);
  assert.ok(sectorFactor(spot, 'RWA').score < -0.9);
  assert.equal(sectorFactor(spot, 'NFT').available, false);
});

test('headline sentiment handles polarity and negation', () => {
  assert.ok(headlineSentiment('Spot ETF approved as inflows surge') > 0);
  assert.ok(headlineSentiment('Exchange hacked, funds drained in exploit') < 0);
  assert.ok(headlineSentiment('SEC does not approve the filing') <= 0);
  assert.equal(headlineSentiment('Weekly schedule published'), 0);
});

test('news factor weights recent articles more and keeps linked evidence', () => {
  const items = [
    { title: 'Bitcoin rally extends as ETF inflows surge', release_time: NOW - 1 * 3.6e6, source_link: 'https://x/1' },
    { title: 'Miners sell as hashprice drops', release_time: NOW - 96 * 3.6e6, source_link: 'https://x/2' },
  ];
  const f = newsFactor(items, { now: NOW });
  assert.ok(f.score > 0);
  assert.equal(f.evidence[0].url, 'https://x/1');
  assert.equal(newsFactor([], { now: NOW }).available, false);
});

test('macro risk counts only high-impact releases inside the window', () => {
  const events = [
    { date: '2026-11-17', events: ['Core PCE Price Index (MoM)', 'New Home Sales'] },
    { date: '2026-11-25', events: ['CPI (YoY)'] },
  ];
  const fomc = { rate_ranges: ['400-425', '425-450'], meetings: [{ meeting_date: '2026-12-09', probabilities: ['95.4', '4.6'] }] };
  const m = macroRisk(events, fomc, { now: NOW });
  assert.equal(m.upcoming.length, 1);
  assert.equal(m.risk, 0.25);
  assert.equal(m.nextMeeting.mostLikelyRange, '400-425');
});

test('composite: agreeing factors give a confident BUY; macro risk lowers confidence', () => {
  const factors = { flow: { score: 0.7 }, momentum: { score: 0.5 }, news: { score: 0.4 }, regime: { score: 0.2 } };
  const calm = compositeSignal('major', factors, { macro: { risk: 0 } });
  const stormy = compositeSignal('major', factors, { macro: { risk: 1 } });
  assert.equal(calm.stance, 'BUY');
  assert.equal(calm.agreement, 1);
  assert.ok(stormy.confidence < calm.confidence);
});

test('composite: conflicting factors stay HOLD', () => {
  const s = compositeSignal('major', { flow: { score: 0.6 }, momentum: { score: -0.6 }, news: { score: 0.1 }, regime: { score: -0.1 } });
  assert.equal(s.stance, 'HOLD');
});

test('composite: missing factors are re-weighted and reduce coverage', () => {
  const full = compositeSignal('index', { momentum: { score: 0.6 }, sector: { score: 0.6 }, news: { score: 0.6 }, regime: { score: 0.6 } });
  const partial = compositeSignal('index', { momentum: { score: 0.6 }, sector: { available: false, score: 0 }, news: { score: 0.6 }, regime: { score: 0.6 } });
  assert.equal(partial.score, full.score);
  assert.ok(partial.confidence < full.confidence);
});

test('regime: market-cap change from the API is in percent units', () => {
  const r = regimeFactor({ total_market_cap_change_pct: '4' }, { score: 0.8 }, { risk: 0 });
  assert.equal(r.label, 'RISK-ON');
  assert.equal(r.marketCapChange24h, 0.04);
});

const asset = (over = {}) => ({
  id: 'BTC', label: 'Bitcoin', kind: 'major',
  venue: { network: 'mainnet', market: 'perps', symbol: 'BTC-USD' },
  factors: { momentum: { dailyRangePct: 0.03 } },
  signal: { stance: 'BUY', confidence: 0.6, score: 0.5, contributions: [] },
  ...over,
});

test('risk: size = risk budget / stop, capped by max position', () => {
  const { decisions } = sizePositions([asset()], { macro: { risk: 0 } });
  const d = decisions[0];
  assert.equal(d.action, 'PROPOSE');
  assert.equal(d.stopPct, 0.045);
  assert.ok(Math.abs(d.notional - (10000 * 0.01 * 0.6) / 0.045) < 0.01);
  assert.ok(d.maxLoss <= DEFAULT_RISK.equity * DEFAULT_RISK.riskPerTrade);
});

test('risk: guards block spot shorts, missing venues and new longs in a macro storm', () => {
  const spotShort = asset({ id: 'X', venue: { network: 'mainnet', market: 'spot', symbol: 'X' }, signal: { stance: 'SELL', confidence: 0.7 } });
  const noVenue = asset({ id: 'Y', venue: null });
  const { decisions } = sizePositions([spotShort, noVenue, asset({ id: 'Z' })], { macro: { risk: 0.9 } });
  const by = Object.fromEntries(decisions.map((d) => [d.id, d]));
  assert.match(by.X.guards.join(), /cannot short/);
  assert.match(by.Y.guards.join(), /no SoDEX market/);
  assert.match(by.Z.guards.join(), /new longs paused/);
});

test('risk: gross exposure cap is enforced across tickets', () => {
  const many = Array.from({ length: 6 }, (_, i) => asset({ id: `A${i}`, signal: { stance: 'BUY', confidence: 1 }, factors: { momentum: { dailyRangePct: 0.001 } } }));
  const s = sizePositions(many, { macro: { risk: 0 } });
  assert.ok(s.grossExposure <= DEFAULT_RISK.equity * DEFAULT_RISK.maxGrossExposure + 1e-6);
  assert.ok(s.decisions.some((d) => d.guards.includes('gross exposure cap reached')));
});

test('stop distance is clamped', () => {
  assert.equal(stopDistance(asset({ factors: { momentum: { dailyRangePct: 0.0001 } } })), DEFAULT_RISK.minStopPct);
  assert.equal(stopDistance(asset({ factors: { momentum: { dailyRangePct: 0.5 } } })), DEFAULT_RISK.maxStopPct);
});

const BOOK = {
  bids: [['99', '10'], ['98', '10']],
  asks: [['101', '1'], ['102', '1'], ['110', '100']],
};

test('fill simulation walks the book and reports slippage', () => {
  const s = simulateFill(BOOK, 'BUY', 203);
  assert.equal(s.levelsUsed, 2);
  assert.equal(s.mid, 100);
  assert.ok(Math.abs(s.avgPrice - 101.5) < 1e-9);
  assert.equal(s.slippageBps, 150);
  assert.equal(s.fillRatio, 1);
});

test('tickets above the slippage limit or on thin books are blocked; good ones await confirmation', () => {
  const run = 'r1';
  const TIGHT = { bids: [['99.99', '50'], ['99.98', '50']], asks: [['100.01', '50'], ['100.02', '50']] };
  const ok = buildTicket({ asset: asset(), decision: { side: 'SELL', notional: 500, stopPct: 0.05, maxLoss: 25 }, book: TIGHT, runId: run });
  assert.equal(ok.status, 'AWAITING_CONFIRMATION');
  assert.ok(ok.stopPrice > ok.estAvgPrice);
  const slip = buildTicket({ asset: asset(), decision: { side: 'BUY', notional: 1000, stopPct: 0.05 }, book: BOOK, runId: run });
  assert.equal(slip.status, 'BLOCKED');
  assert.match(slip.reasons.join(), /slippage/);
  const thin = buildTicket({ asset: asset(), decision: { side: 'BUY', notional: 1e6, stopPct: 0.05 }, book: BOOK, runId: run });
  assert.match(thin.reasons.join(), /too thin/);
  const empty = buildTicket({ asset: asset(), decision: { side: 'BUY', notional: 10, stopPct: 0.05 }, book: { bids: [], asks: [] }, runId: run });
  assert.equal(empty.status, 'BLOCKED');
});

test('ticket ids are deterministic per run, asset and side', () => {
  const d = { side: 'SELL', notional: 100, stopPct: 0.05 };
  const a = buildTicket({ asset: asset(), decision: d, book: BOOK, runId: 'x' });
  const b = buildTicket({ asset: asset(), decision: d, book: BOOK, runId: 'x' });
  const c = buildTicket({ asset: asset(), decision: d, book: BOOK, runId: 'y' });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test('paper ledger marks tickets to market and applies stops', () => {
  const runs = [{ at: 't0', tickets: [
    { id: 'a', asset: 'BTC', symbol: 'BTC-USD', side: 'BUY', notional: 1000, entry: 100, stop: 95 },
    { id: 'b', asset: 'ETH', symbol: 'ETH-USD', side: 'SELL', notional: 1000, entry: 100, stop: 105 },
  ] }];
  const t = markToMarket(runs, { 'BTC-USD': 90, 'ETH-USD': 90 });
  const a = t.rows.find((r) => r.id === 'a');
  const b = t.rows.find((r) => r.id === 'b');
  assert.equal(a.stopped, true);
  assert.equal(a.pnl, -50);
  assert.equal(b.pnl, 100);
  assert.equal(t.pnl, 50);
  assert.equal(t.hitRate, 50);
});

test('explainer cites the strongest factors and the desk brief names the top idea', () => {
  const factors = {
    flow: { score: -0.7, note: '5-day net -$1.0B' }, momentum: { score: -0.3, note: 'lower third' },
    news: { score: 0.2, note: '3 positive' }, regime: { score: 0, note: 'neutral' },
  };
  const signal = compositeSignal('major', factors);
  const a = { id: 'BTC', label: 'Bitcoin', factors, signal };
  const e = explainAsset(a);
  assert.match(e.why, /ETF flows/);
  assert.match(e.risk, /news sentiment/);
  const brief = deskBrief({ regime: { label: 'NEUTRAL', note: 'n' }, macro: { note: 'm' }, assets: [a], tickets: [] });
  assert.equal(brief.headline, `${signal.stance === 'HOLD' ? 'Stay flat' : `${signal.stance} Bitcoin`}`);
});

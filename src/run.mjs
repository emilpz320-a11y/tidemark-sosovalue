#!/usr/bin/env node
// Tidemark agent run: SoSoValue data -> factors -> signals -> risk -> SoDEX-priced tickets -> JSON snapshot.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoSoValue, createSoDex } from './clients.mjs';
import {
  etfFlowFactor, coinMomentumFactor, indexMomentumFactor, sectorFactor, newsFactor,
  macroRisk, regimeFactor, compositeSignal,
} from './signals.mjs';
import { sizePositions, DEFAULT_RISK } from './risk.mjs';
import { buildTicket } from './execution.mjs';
import { explainAsset, deskBrief } from './explain.mjs';
import { markToMarket } from './ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'data');

export const UNIVERSE = [
  { id: 'BTC', label: 'Bitcoin', kind: 'major', etf: 'BTC', venue: { network: 'mainnet', market: 'perps', symbol: 'BTC-USD' } },
  { id: 'ETH', label: 'Ethereum', kind: 'major', etf: 'ETH', venue: { network: 'mainnet', market: 'perps', symbol: 'ETH-USD' } },
  { id: 'SOL', label: 'Solana', kind: 'major', etf: 'SOL', venue: { network: 'mainnet', market: 'perps', symbol: 'SOL-USD' } },
  { id: 'ssiMAG7', label: 'SSI MAG7 index', kind: 'index', sector: null, newsTags: [], venue: { network: 'mainnet', market: 'spot', symbol: 'vMAG7ssi_vUSDC' } },
  { id: 'ssiDeFi', label: 'SSI DeFi index', kind: 'index', sector: 'DeFi', newsTags: ['defi'], venue: { network: 'mainnet', market: 'spot', symbol: 'vDEFIssi_vUSDC' } },
  { id: 'ssiMeme', label: 'SSI Meme index', kind: 'index', sector: 'Meme', newsTags: ['meme', 'memecoin'], venue: { network: 'mainnet', market: 'spot', symbol: 'vMEMEssi_vUSDC' } },
  { id: 'ssiAI', label: 'SSI AI index', kind: 'index', sector: 'AI', newsTags: [' ai ', 'artificial intelligence', 'agent'], venue: null },
  { id: 'ssiLayer1', label: 'SSI Layer1 index', kind: 'index', sector: 'Layer1', newsTags: ['layer 1', 'layer1', 'l1'], venue: null },
  { id: 'ssiRWA', label: 'SSI RWA index', kind: 'index', sector: 'RWA', newsTags: ['rwa', 'tokeniz', 'real-world asset'], venue: null },
];

function loadKey() {
  if (process.env.SOSO_API_KEY) return process.env.SOSO_API_KEY.trim();
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^SOSO_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('Set SOSO_API_KEY (env var or .env)');
}

const safe = async (p, fallback = null, errors, label) => {
  try {
    return await p;
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return fallback;
  }
};

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function run({ now = Date.now(), write = true } = {}) {
  const soso = createSoSoValue(loadKey());
  const errors = [];
  const runId = new Date(now).toISOString();

  // 1. Shared context
  const [overview, spotlight, macroEvents, fomc, currencies, hot] = await Promise.all([
    safe(soso.marketOverview(), null, errors, 'overview'),
    safe(soso.sectorSpotlight(), null, errors, 'sector spotlight'),
    safe(soso.macroEvents(), [], errors, 'macro events'),
    safe(soso.fomc(), null, errors, 'fomc'),
    safe(soso.currencies(), [], errors, 'currencies'),
    safe(soso.hotNews(50), { list: [] }, errors, 'hot news'),
  ]);
  const macro = macroRisk(macroEvents, fomc, { now });
  const idBySymbol = Object.fromEntries((currencies ?? []).map((c) => [String(c.symbol).toUpperCase(), c.currency_id]));
  const hotList = hot?.list ?? [];

  // 2. Per-asset factors
  const assets = [];
  for (const u of UNIVERSE) {
    const factors = {};
    if (u.kind === 'major') {
      const cid = idBySymbol[u.id];
      const [flows, snap, news] = await Promise.all([
        safe(soso.etfFlows(u.etf, 30), [], errors, `${u.id} ETF flows`),
        cid ? safe(soso.currencySnapshot(cid), null, errors, `${u.id} snapshot`) : null,
        cid ? safe(soso.news(cid, 25), { list: [] }, errors, `${u.id} news`) : { list: [] },
      ]);
      factors.flow = etfFlowFactor(flows);
      factors.momentum = coinMomentumFactor(snap);
      factors.news = newsFactor(news?.list ?? news, { now });
      factors.price = snap?.price ?? null;
    } else {
      const snap = await safe(soso.indexSnapshot(u.id), null, errors, `${u.id} snapshot`);
      factors.momentum = indexMomentumFactor(snap);
      factors.sector = u.sector ? sectorFactor(spotlight, u.sector) : { score: 0, available: false, note: 'cross-sector index' };
      const related = u.newsTags.length
        ? hotList.filter((n) => u.newsTags.some((t) => ` ${n.title} ${n.tags ?? ''} `.toLowerCase().includes(t)))
        : hotList;
      factors.news = newsFactor(related, { now });
      factors.price = snap?.price ?? null;
    }
    assets.push({ ...u, factors, dataTime: now });
  }

  const btc = assets.find((a) => a.id === 'BTC');
  const regime = regimeFactor(overview, btc?.factors.flow, macro);
  for (const a of assets) {
    a.factors.regime = regime;
    a.signal = compositeSignal(a.kind, a.factors, { macro });
    a.explain = explainAsset(a);
  }

  // 3. Risk + execution pricing on live SoDEX books
  const sizing = sizePositions(assets, { macro, cfg: DEFAULT_RISK, now });
  const sodex = createSoDex('mainnet');
  const tickets = [];
  for (const d of sizing.decisions) {
    const a = assets.find((x) => x.id === d.id);
    a.decision = d;
    if (d.action !== 'PROPOSE') continue;
    const book = await safe(sodex.orderbook(a.venue.market, a.venue.symbol), null, errors, `${a.id} order book`);
    const t = buildTicket({ asset: a, decision: d, book, runId });
    tickets.push(t);
    a.ticket = t.id;
  }

  // 4. Paper track record: mark earlier tickets to current SoDEX prices
  const histPath = join(OUT_DIR, 'history.json');
  const history = readJson(histPath, { runs: [] });
  const [perpTickers, spotTickers] = await Promise.all([
    safe(sodex.tickers('perps'), [], errors, 'perps tickers'),
    safe(sodex.tickers('spot'), [], errors, 'spot tickers'),
  ]);
  const lastPx = Object.fromEntries([...(perpTickers ?? []), ...(spotTickers ?? [])].map((t) => [t.symbol, parseFloat(t.lastPx)]));
  const track = markToMarket(history.runs, lastPx);

  const snapshot = {
    project: 'Tidemark',
    version: 1,
    generatedAt: runId,
    sources: { sosovalueCalls: soso.callCount, sodex: 'mainnet public order books (read-only)' },
    regime,
    macro,
    brief: deskBrief({ regime, macro, assets, tickets }),
    assets: assets.map(({ dataTime, newsTags, ...a }) => a),
    sizing: { grossExposure: sizing.grossExposure, grossPct: sizing.grossPct, config: DEFAULT_RISK },
    tickets,
    track,
    errors,
  };

  if (write) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));
    history.runs.push({
      at: runId,
      regime: regime.label,
      macroRisk: macro.risk,
      signals: assets.map((a) => ({ id: a.id, score: a.signal.score, confidence: a.signal.confidence, stance: a.signal.stance, price: a.factors.price })),
      tickets: tickets
        .filter((t) => t.status === 'AWAITING_CONFIRMATION')
        .map((t) => ({ id: t.id, asset: t.asset, symbol: t.symbol, side: t.side, notional: t.notional, entry: t.estAvgPrice, stop: t.stopPrice })),
    });
    history.runs = history.runs.slice(-180);
    writeFileSync(histPath, JSON.stringify(history, null, 2));
  }
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run()
    .then((s) => {
      console.log(`[tidemark] ${s.generatedAt} regime=${s.regime.label} macroRisk=${s.macro.risk}`);
      for (const a of s.assets) console.log(`  ${a.id.padEnd(10)} ${a.signal.stance.padEnd(5)} score=${a.signal.score} conf=${a.signal.confidence}`);
      console.log(`  tickets: ${s.tickets.map((t) => `${t.side} ${t.symbol} $${t.notional} ${t.status} slip=${t.slippageBps ?? '-'}bps`).join(' | ') || 'none'}`);
      if (s.errors.length) console.log(`  errors: ${s.errors.join(' ; ')}`);
    })
    .catch((e) => {
      console.error(`[tidemark] failed: ${e.message}`);
      process.exit(1);
    });
}

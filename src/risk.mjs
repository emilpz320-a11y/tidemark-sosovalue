// Risk engine: turns a signal into a position size, or explains why it refuses to.

export const DEFAULT_RISK = {
  equity: 10000, // paper account, USD
  riskPerTrade: 0.01, // max loss per idea if the stop is hit
  maxPosition: 0.2, // of equity
  maxGrossExposure: 0.6, // of equity, across all tickets in one run
  minStopPct: 0.02,
  maxStopPct: 0.12,
  minConfidence: 0.2,
  maxMacroRisk: 0.75, // above this the desk only allows de-risking
  maxDataAgeHours: 72,
};

const r2 = (x) => Math.round(x * 100) / 100;

/** Stop distance from realised volatility proxies, clamped to sane bounds. */
export function stopDistance(asset, cfg = DEFAULT_RISK) {
  const m = asset.factors?.momentum ?? {};
  let vol = null;
  if (typeof m.dailyRangePct === 'number' && m.dailyRangePct > 0) vol = 1.5 * m.dailyRangePct;
  else if (typeof m.roi7d === 'number') vol = Math.abs(m.roi7d) / Math.sqrt(7) * 2;
  const s = vol ?? 0.04;
  return Math.min(cfg.maxStopPct, Math.max(cfg.minStopPct, s));
}

/**
 * Size every actionable signal. Returns one decision per asset with either a notional size
 * or the list of guards that blocked it.
 */
export function sizePositions(assets, { macro = { risk: 0 }, cfg = DEFAULT_RISK, now = Date.now() } = {}) {
  let gross = 0;
  const out = [];
  const ranked = [...assets].sort((a, b) => b.signal.confidence - a.signal.confidence);
  for (const a of ranked) {
    const guards = [];
    const { stance, confidence } = a.signal;
    if (stance !== 'BUY' && stance !== 'SELL') {
      out.push({ id: a.id, action: 'NONE', guards: ['no actionable stance'] });
      continue;
    }
    if (!a.venue) guards.push('no SoDEX market for this asset');
    if (stance === 'SELL' && a.venue?.market === 'spot') guards.push('spot market: cannot short, reduce existing holdings only');
    if (confidence < cfg.minConfidence) guards.push(`confidence ${confidence} below ${cfg.minConfidence}`);
    if (macro.risk > cfg.maxMacroRisk && stance === 'BUY') guards.push(`macro risk ${macro.risk} above ${cfg.maxMacroRisk}: new longs paused`);
    if (a.dataTime && (now - a.dataTime) / 3.6e6 > cfg.maxDataAgeHours) guards.push('stale data');

    const stop = stopDistance(a, cfg);
    const riskBudget = cfg.equity * cfg.riskPerTrade * confidence * (1 - 0.5 * macro.risk);
    let notional = riskBudget / stop;
    notional = Math.min(notional, cfg.equity * cfg.maxPosition);
    const room = cfg.equity * cfg.maxGrossExposure - gross;
    if (notional > room) {
      if (room <= 50) guards.push('gross exposure cap reached');
      notional = Math.max(0, room);
    }
    if (guards.length) {
      out.push({ id: a.id, action: 'BLOCKED', side: stance, guards, stopPct: Math.round(stop * 10000) / 10000 });
      continue;
    }
    gross += notional;
    out.push({
      id: a.id,
      action: 'PROPOSE',
      side: stance,
      notional: r2(notional),
      stopPct: Math.round(stop * 10000) / 10000,
      maxLoss: r2(notional * stop),
      guards: [],
    });
  }
  return { decisions: out, grossExposure: r2(gross), grossPct: r2((gross / cfg.equity) * 100) };
}

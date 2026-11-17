// Paper track record: what would every proposed ticket be worth now, if it had been confirmed?
// We only see prices at run times, not the path in between, so a stop is applied when the
// current price is beyond it. Intra-run stop-outs can be missed: treat this as an approximation.

export function markToMarket(runs, lastPx) {
  const rows = [];
  for (const r of runs ?? []) {
    for (const t of r.tickets ?? []) {
      const px = lastPx[t.symbol];
      if (!Number.isFinite(px) || !t.entry) continue;
      const dir = t.side === 'BUY' ? 1 : -1;
      let exit = px;
      let stopped = false;
      if (t.stop && ((dir === 1 && px <= t.stop) || (dir === -1 && px >= t.stop))) {
        exit = t.stop;
        stopped = true;
      }
      const ret = (dir * (exit - t.entry)) / t.entry;
      rows.push({
        id: t.id,
        openedAt: r.at,
        asset: t.asset,
        symbol: t.symbol,
        side: t.side,
        entry: t.entry,
        mark: px,
        stopped,
        returnPct: Math.round(ret * 10000) / 100,
        pnl: Math.round(t.notional * ret * 100) / 100,
      });
    }
  }
  const pnl = rows.reduce((s, x) => s + x.pnl, 0);
  const wins = rows.filter((x) => x.pnl > 0).length;
  return {
    tickets: rows.length,
    pnl: Math.round(pnl * 100) / 100,
    hitRate: rows.length ? Math.round((wins / rows.length) * 100) : null,
    rows: rows.slice(-25).reverse(),
  };
}

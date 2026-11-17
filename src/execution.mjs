// Execution planner: walks a live SoDEX order book to price a ticket before anyone confirms it.
// Nothing here signs or sends orders; tickets are emitted as AWAITING_CONFIRMATION.

const num = (v) => parseFloat(v);

/** Simulate a market order of `notional` USD against one side of the book. */
export function simulateFill(book, side, notional) {
  const bids = (book?.bids ?? []).map(([p, q]) => [num(p), num(q)]).filter(([p, q]) => p > 0 && q > 0);
  const asks = (book?.asks ?? []).map(([p, q]) => [num(p), num(q)]).filter(([p, q]) => p > 0 && q > 0);
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return { ok: false, reason: 'empty order book' };
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const spreadBps = ((asks[0][0] - bids[0][0]) / mid) * 1e4;
  const levels = side === 'BUY' ? asks : bids;
  let remaining = notional;
  let qty = 0;
  let cost = 0;
  let used = 0;
  let worst = levels[0][0];
  for (const [p, q] of levels) {
    if (remaining <= 1e-9) break;
    const take = Math.min(q, remaining / p);
    qty += take;
    cost += take * p;
    remaining -= take * p;
    worst = p;
    used++;
  }
  const filled = cost;
  const avg = qty ? cost / qty : NaN;
  const slippageBps = qty ? (side === 'BUY' ? (avg - mid) / mid : (mid - avg) / mid) * 1e4 : NaN;
  return {
    ok: true,
    mid,
    spreadBps: round(spreadBps, 1),
    avgPrice: avg,
    worstPrice: worst,
    quantity: qty,
    filledNotional: round(filled, 2),
    fillRatio: round(filled / notional, 4),
    levelsUsed: used,
    slippageBps: round(slippageBps, 1),
  };
}

const round = (x, p = 2) => Math.round(x * 10 ** p) / 10 ** p;

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Build a confirm-before-send ticket, or a blocked one with reasons. */
export function buildTicket({ asset, decision, book, runId, maxSlippageBps = 30, minFillRatio = 0.98 }) {
  const base = {
    id: `tm-${hash(`${runId}:${asset.id}:${decision.side}`)}`,
    asset: asset.id,
    label: asset.label,
    venue: asset.venue ? `SoDEX ${asset.venue.network} ${asset.venue.market}` : null,
    symbol: asset.venue?.symbol ?? null,
    side: decision.side,
    notional: decision.notional,
  };
  const sim = simulateFill(book, decision.side, decision.notional);
  if (!sim.ok) return { ...base, status: 'BLOCKED', reasons: [sim.reason] };
  const reasons = [];
  if (sim.fillRatio < minFillRatio) reasons.push(`book too thin: only ${(sim.fillRatio * 100).toFixed(1)}% fillable`);
  if (sim.slippageBps > maxSlippageBps) reasons.push(`estimated slippage ${sim.slippageBps} bps > ${maxSlippageBps} bps limit`);
  const stopPrice = decision.side === 'BUY' ? sim.avgPrice * (1 - decision.stopPct) : sim.avgPrice * (1 + decision.stopPct);
  return {
    ...base,
    status: reasons.length ? 'BLOCKED' : 'AWAITING_CONFIRMATION',
    reasons,
    orderType: 'LIMIT_IOC',
    limitPrice: sim.worstPrice,
    estAvgPrice: sim.avgPrice,
    quantity: sim.quantity,
    stopPrice,
    stopPct: decision.stopPct,
    maxLoss: decision.maxLoss,
    spreadBps: sim.spreadBps,
    slippageBps: sim.slippageBps,
    levelsUsed: sim.levelsUsed,
    mid: sim.mid,
  };
}

// Deterministic explainer: turns factor contributions into plain-English reasoning.
// Every sentence is derived from numbers in the snapshot, so it can be audited.

const FACTOR_NAMES = {
  flow: 'ETF flows',
  momentum: 'price momentum',
  news: 'news sentiment',
  sector: 'sector breadth',
  regime: 'market regime',
};

function tone(score) {
  if (score >= 0.5) return 'strongly supportive';
  if (score >= 0.15) return 'supportive';
  if (score > -0.15) return 'neutral';
  if (score > -0.5) return 'negative';
  return 'strongly negative';
}

export function explainAsset(asset) {
  const { signal, factors } = asset;
  const parts = signal.contributions
    .filter((c) => Math.abs(c.score) > 0.05)
    .slice(0, 3)
    .map((c) => `${FACTOR_NAMES[c.factor]} ${tone(c.score)} (${factors[c.factor]?.note ?? 'n/a'})`);
  const against = signal.contributions.find((c) => Math.sign(c.score) !== Math.sign(signal.score) && Math.abs(c.score) > 0.1);
  const verb = { BUY: 'Lean long', SELL: 'Lean short / reduce', HOLD: 'Stay flat', 'NO DATA': 'No call' }[signal.stance];
  const summary = `${verb} ${asset.label}: composite ${signal.score >= 0 ? '+' : ''}${signal.score}, confidence ${signal.confidence}.`;
  const why = parts.length ? `Drivers: ${parts.join('; ')}.` : 'No factor is far enough from neutral to justify a trade.';
  const risk = against
    ? `What would change the view: ${FACTOR_NAMES[against.factor]} is pointing the other way (${factors[against.factor]?.note}).`
    : signal.stance === 'HOLD'
      ? 'A move in ETF flows or momentum beyond the entry threshold (|score| ≥ 0.2) would trigger a ticket.'
      : 'All live factors agree; the main risk is a macro surprise.';
  return { summary, why, risk };
}

export function deskBrief({ regime, macro, assets, tickets }) {
  const ideas = assets
    .filter((a) => a.signal.stance === 'BUY' || a.signal.stance === 'SELL')
    .sort((a, b) => b.signal.confidence - a.signal.confidence);
  const ready = tickets.filter((t) => t.status === 'AWAITING_CONFIRMATION');
  // Lead with what the desk can actually act on: a priced ticket first, then any tradeable idea.
  const ticketed = ideas.find((a) => ready.some((t) => t.asset === a.id));
  const top = ticketed ?? ideas.find((a) => a.venue) ?? ideas[0];
  const watch = ideas.filter((a) => !a.venue).map((a) => `${a.signal.stance} ${a.label}`);
  const lines = [];
  lines.push(`Regime: ${regime.note}.`);
  lines.push(`Macro: ${macro.note}${macro.nextMeeting ? `; next FOMC ${macro.nextMeeting.date} (${macro.nextMeeting.probability}% on ${macro.nextMeeting.mostLikelyRange} bps)` : ''}.`);
  lines.push(
    top
      ? `Top idea: ${top.signal.stance} ${top.label} (confidence ${top.signal.confidence}). ${ideas.length} actionable signal(s) out of ${assets.length} assets.`
      : `No actionable signals across ${assets.length} assets; the desk stays flat.`,
  );
  lines.push(
    ready.length
      ? `${ready.length} ticket(s) priced against live SoDEX books and waiting for human confirmation.`
      : 'No tickets passed the risk and liquidity guards this run.',
  );
  if (watch.length) lines.push(`Watchlist only (no SoDEX market): ${watch.join(', ')}.`);
  return { headline: top ? `${top.signal.stance} ${top.label}` : 'Stay flat', lines };
}

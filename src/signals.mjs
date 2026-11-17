// Pure signal functions. Every factor returns a score in [-1, 1] plus the evidence behind it,
// so the dashboard can always show *why* a signal fired.

const num = (v, d = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
export const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x, p = 3) => Math.round(x * 10 ** p) / 10 ** p;

/** ETF flow factor: last-5-day net flow relative to the typical daily absolute flow. */
export function etfFlowFactor(history) {
  const rows = (history ?? []).filter((r) => r && r.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (rows.length < 5) return { score: 0, available: false, note: 'not enough ETF history' };
  const flows = rows.map((r) => num(r.total_net_inflow));
  const last5 = flows.slice(0, 5).reduce((s, x) => s + x, 0);
  const meanAbs = flows.reduce((s, x) => s + Math.abs(x), 0) / flows.length || 1;
  let streak = 0;
  const sign = Math.sign(flows[0]);
  for (const f of flows) {
    if (Math.sign(f) === sign && sign !== 0) streak++;
    else break;
  }
  const score = clamp(Math.tanh(last5 / (5 * meanAbs)));
  return {
    score: round(score),
    available: true,
    last5d: Math.round(last5),
    lastDay: Math.round(flows[0]),
    lastDate: rows[0].date,
    streak: streak * sign,
    totalNetAssets: Math.round(num(rows[0].total_net_assets)),
    note: `${sign >= 0 ? 'inflow' : 'outflow'} streak of ${streak} day(s); 5-day net ${fmtUsd(last5)}`,
  };
}

/** Momentum for a single coin from its market snapshot (24h change + position in the 24h range). */
export function coinMomentumFactor(snap) {
  if (!snap || !num(snap.price)) return { score: 0, available: false, note: 'no snapshot' };
  const price = num(snap.price);
  const hi = num(snap.high_24h, price);
  const lo = num(snap.low_24h, price);
  const chg = num(snap.change_pct_24h);
  const rangePos = hi > lo ? ((price - lo) / (hi - lo)) * 2 - 1 : 0;
  const score = clamp(0.6 * Math.tanh(chg / 0.03) + 0.4 * rangePos);
  return {
    score: round(score),
    available: true,
    change24h: chg,
    rangePosition: round(rangePos),
    dailyRangePct: price ? round((hi - lo) / price, 4) : null,
    note: `${pct(chg)} in 24h, trading in the ${rangePos > 0.33 ? 'upper' : rangePos < -0.33 ? 'lower' : 'middle'} third of its daily range`,
  };
}

/** Momentum for an SSI index from its snapshot (24h, 7d and 1m returns). */
export function indexMomentumFactor(snap) {
  if (!snap || !num(snap.price)) return { score: 0, available: false, note: 'no snapshot' };
  const c24 = num(snap.change_pct_24h);
  const r7 = num(snap.roi_7d);
  const r30 = num(snap.roi_1m);
  const score = clamp(0.2 * Math.tanh(c24 / 0.03) + 0.4 * Math.tanh(r7 / 0.1) + 0.4 * Math.tanh(r30 / 0.2));
  return {
    score: round(score),
    available: true,
    change24h: c24,
    roi7d: r7,
    roi1m: r30,
    note: `24h ${pct(c24)}, 7d ${pct(r7)}, 30d ${pct(r30)}`,
  };
}

/** Sector breadth from the SoSoValue sector spotlight. */
export function sectorFactor(spotlight, sectorName) {
  const sectors = spotlight?.sector ?? [];
  const row = sectors.find((s) => s.name?.toLowerCase() === sectorName?.toLowerCase());
  if (!row) return { score: 0, available: false, note: 'sector not in spotlight' };
  const ranked = [...sectors].sort((a, b) => num(b.change_pct_24h) - num(a.change_pct_24h));
  const rank = ranked.findIndex((s) => s === row) + 1;
  const median = num(ranked[Math.floor(ranked.length / 2)]?.change_pct_24h);
  const rel = num(row.change_pct_24h) - median;
  return {
    score: round(clamp(Math.tanh(rel / 0.02))),
    available: true,
    rank,
    of: ranked.length,
    change24h: num(row.change_pct_24h),
    note: `#${rank}/${ranked.length} sectors today (${pct(num(row.change_pct_24h))}, ${pct(rel)} vs median)`,
  };
}

// --- News sentiment -------------------------------------------------------------------------

const POSITIVE = [
  'approve', 'approval', 'approved', 'inflow', 'inflows', 'surge', 'surges', 'rally', 'rallies', 'record high',
  'all-time high', 'adopt', 'adoption', 'partnership', 'launch', 'launches', 'upgrade', 'bullish', 'gain', 'gains',
  'accumulate', 'accumulates', 'buy', 'buys', 'purchase', 'purchases', 'rebound', 'rebounds', 'recover', 'recovers',
  'breakout', 'integrat', 'expand', 'expands', 'growth', 'beat', 'beats', 'commitment', 'commitments', 'support',
];
const NEGATIVE = [
  'hack', 'hacked', 'exploit', 'outflow', 'outflows', 'plunge', 'plunges', 'crash', 'crashes', 'dump', 'dumps',
  'lawsuit', 'sue', 'sues', 'fraud', 'guilty', 'insider trading', 'ban', 'bans', 'bearish', 'liquidation',
  'liquidations', 'sell-off', 'selloff', 'sell', 'sells', 'drop', 'drops', 'fall', 'falls', 'decline', 'declines',
  'delay', 'delays', 'reject', 'rejects', 'rejected', 'investigation', 'probe', 'warning', 'loss', 'losses', 'halt',
];
const NEGATIONS = ['not', 'no', "n't", 'without', 'fails to', 'failed to'];

function countHits(text, words) {
  let hits = 0;
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 14), m.index);
      hits += NEGATIONS.some((n) => before.includes(n)) ? -1 : 1;
    }
  }
  return hits;
}

/** Score a single headline/body in [-1, 1]. */
export function headlineSentiment(title = '', content = '') {
  const text = `${title} ${title} ${content}`.toLowerCase(); // title counts double
  const pos = countHits(text, POSITIVE);
  const neg = countHits(text, NEGATIVE);
  const total = Math.abs(pos) + Math.abs(neg);
  if (!total) return 0;
  return round(clamp((pos - neg) / (total + 1)));
}

/** Recency-weighted news sentiment with the strongest items kept as evidence. */
export function newsFactor(items, { now = Date.now(), halfLifeHours = 24, maxEvidence = 3 } = {}) {
  const list = (items ?? []).filter((n) => n && n.title);
  if (!list.length) return { score: 0, available: false, note: 'no recent news', evidence: [] };
  let wsum = 0;
  let ssum = 0;
  const scored = list.map((n) => {
    const ageH = Math.max(0, (now - num(n.release_time, now)) / 3.6e6);
    const w = 0.5 ** (ageH / halfLifeHours);
    const s = headlineSentiment(n.title, String(n.content ?? '').slice(0, 400));
    wsum += w;
    ssum += w * s;
    return {
      title: n.title.trim(),
      url: n.source_link || n.original_link || null,
      ageHours: round(ageH, 1),
      sentiment: s,
      weight: w,
    };
  });
  const score = wsum ? clamp(ssum / wsum) : 0;
  const evidence = scored
    .filter((e) => e.sentiment !== 0)
    .sort((a, b) => Math.abs(b.sentiment) * b.weight - Math.abs(a.sentiment) * a.weight)
    .slice(0, maxEvidence)
    .map(({ weight, ...e }) => e);
  const pos = scored.filter((e) => e.sentiment > 0).length;
  const neg = scored.filter((e) => e.sentiment < 0).length;
  return {
    score: round(score),
    available: true,
    articles: list.length,
    positive: pos,
    negative: neg,
    evidence,
    note: `${list.length} articles: ${pos} positive, ${neg} negative (recency-weighted)`,
  };
}

// --- Macro ----------------------------------------------------------------------------------

const HIGH_IMPACT = /(cpi|pce|fomc|interest rate|nonfarm|non-farm|payroll|gdp|unemployment rate|powell)/i;

/** Macro risk in [0, 1]: high-impact releases in the next 48h plus FOMC uncertainty. */
export function macroRisk(events, fomc, { now = Date.now(), windowHours = 48 } = {}) {
  const upcoming = [];
  for (const day of events ?? []) {
    const t = Date.parse(`${day.date}T13:30:00Z`);
    const hours = (t - now) / 3.6e6;
    if (hours < -12 || hours > windowHours) continue;
    for (const e of day.events ?? []) {
      if (HIGH_IMPACT.test(e)) upcoming.push({ date: day.date, event: e.trim(), hours: Math.round(hours) });
    }
  }
  let nextMeeting = null;
  if (fomc?.meetings?.length) {
    const m = [...fomc.meetings].sort((a, b) => (a.meeting_date < b.meeting_date ? -1 : 1))
      .find((x) => Date.parse(x.meeting_date) >= now - 864e5) ?? fomc.meetings[0];
    const probs = m.probabilities.map((p) => num(p, 0));
    const i = probs.indexOf(Math.max(...probs));
    nextMeeting = {
      date: m.meeting_date,
      mostLikelyRange: fomc.rate_ranges?.[i] ?? null,
      probability: probs[i],
      daysAway: Math.round((Date.parse(m.meeting_date) - now) / 864e5),
    };
  }
  const eventRisk = Math.min(1, upcoming.length * 0.25);
  const fomcRisk = nextMeeting
    ? (nextMeeting.daysAway <= 2 ? 0.5 : 0) + (nextMeeting.probability < 70 ? 0.3 : 0)
    : 0;
  const risk = round(clamp(eventRisk + fomcRisk, 0, 1), 2);
  return {
    risk,
    upcoming,
    nextMeeting,
    note: upcoming.length
      ? `${upcoming.length} high-impact release(s) within ${windowHours}h: ${upcoming.map((u) => u.event).join(', ')}`
      : `no high-impact releases within ${windowHours}h`,
  };
}

// --- Composite ------------------------------------------------------------------------------

export const WEIGHTS = {
  major: { flow: 0.35, momentum: 0.3, news: 0.25, regime: 0.1 },
  index: { momentum: 0.45, sector: 0.25, news: 0.15, regime: 0.15 },
};

/** Combine factors. Confidence rewards agreement between factors and penalises macro risk. */
export function compositeSignal(kind, factors, { macro = { risk: 0 }, thresholds = { enter: 0.2, exit: -0.2 } } = {}) {
  const weights = WEIGHTS[kind];
  let wsum = 0;
  let score = 0;
  const contributions = [];
  for (const [name, w] of Object.entries(weights)) {
    const f = factors[name];
    if (!f || f.available === false) continue;
    wsum += w;
    score += w * f.score;
    contributions.push({ factor: name, weight: w, score: f.score, contribution: round(w * f.score) });
  }
  if (!wsum) return { score: 0, confidence: 0, stance: 'NO DATA', contributions };
  score = clamp(score / wsum);
  const live = contributions.filter((c) => Math.abs(c.score) > 0.05);
  const agree = live.length ? live.filter((c) => Math.sign(c.score) === Math.sign(score)).length / live.length : 0;
  const coverage = wsum / Object.values(weights).reduce((s, w) => s + w, 0);
  const confidence = round(clamp(Math.abs(score) * 1.6, 0, 1) * (0.4 + 0.6 * agree) * coverage * (1 - 0.5 * macro.risk), 2);
  let stance = 'HOLD';
  if (score >= thresholds.enter && confidence >= 0.2) stance = 'BUY';
  else if (score <= thresholds.exit && confidence >= 0.2) stance = 'SELL';
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { score: round(score), confidence, stance, agreement: round(agree, 2), contributions };
}

/** Market regime from the global overview, BTC ETF flows and macro risk. */
export function regimeFactor(overview, btcFlow, macro) {
  const capChg = num(overview?.total_market_cap_change_pct) / 100; // API returns percent units
  const s = clamp(0.5 * Math.tanh(capChg / 0.02) + 0.5 * (btcFlow?.score ?? 0) - 0.3 * (macro?.risk ?? 0));
  const label = s > 0.25 ? 'RISK-ON' : s < -0.25 ? 'RISK-OFF' : 'NEUTRAL';
  return {
    score: round(s),
    available: true,
    label,
    marketCapChange24h: capChg,
    note: `${label}: total crypto market cap ${pct(capChg)} in 24h, BTC ETF flow score ${btcFlow?.score ?? 'n/a'}, macro risk ${macro?.risk ?? 0}`,
  };
}

// --- formatting helpers (shared with the explainer) -----------------------------------------

export function pct(x, digits = 2) {
  const v = num(x) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtUsd(x) {
  const v = num(x);
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return `${v < 0 ? '-' : ''}$${s}`;
}

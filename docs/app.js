// Tidemark dashboard. Renders docs/data/latest.json + history.json. No framework, no innerHTML
// for remote text: news titles and API strings always go through textContent.

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const fmt = {
  usd: (x, d = 2) => (Number.isFinite(+x) ? `$${(+x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '—'),
  px: (x) => {
    const v = +x;
    if (!Number.isFinite(v)) return '—';
    const d = v >= 1000 ? 1 : v >= 1 ? 3 : 6;
    return v.toLocaleString('en-US', { maximumFractionDigits: d });
  },
  pct: (x, d = 2) => (Number.isFinite(+x) ? `${+x >= 0 ? '+' : ''}${(+x * 100).toFixed(d)}%` : '—'),
  signed: (x) => (Number.isFinite(+x) ? `${+x >= 0 ? '+' : ''}${(+x).toFixed(2)}` : '—'),
  ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  },
};

// ---------- persistence (per-viewer convenience only) ----------
const STORE = 'tidemark.blotter.v1';
const readBlotter = () => {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
};
const writeBlotter = (b) => {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* private mode: keep in memory */ }
};
let blotter = readBlotter();

// ---------- rendering ----------
function scoreBar(score) {
  const s = Math.max(-1, Math.min(1, +score || 0));
  const w = `${Math.abs(s) * 50}%`;
  return h('div', { class: 'bar', role: 'img', 'aria-label': `score ${fmt.signed(s)}` },
    h('i', { class: s >= 0 ? 'pos' : 'neg', style: `width:${w}` }));
}

function renderMeta(d) {
  const meta = $('#meta');
  meta.replaceChildren(
    h('span', { class: `pill ${d.regime.label}` }, d.regime.label),
    h('span', {}, `Last run ${fmt.ago(d.generatedAt)}`),
    h('span', {}, `· ${d.sources.sosovalueCalls} SoSoValue API calls`),
  );
  meta.title = new Date(d.generatedAt).toString();
}

function renderBrief(d) {
  const b = d.brief;
  $('#brief').replaceChildren(
    h('div', {},
      h('p', { class: 'kicker' }, `Desk brief · ${new Date(d.generatedAt).toUTCString().replace(':00 GMT', ' UTC')}`),
      h('h1', {}, b.headline),
      h('ul', {}, b.lines.map((l) => h('li', {}, l)))),
    h('div', { class: 'badges' },
      h('span', { class: `pill ${d.regime.label}` }, `Regime ${d.regime.label}`),
      h('span', { class: `pill ${d.macro.risk >= 0.5 ? 'warn' : 'NEUTRAL'}` }, `Macro risk ${Math.round(d.macro.risk * 100)}%`),
      h('span', { class: 'pill NEUTRAL' }, `Gross ${d.sizing.grossPct}% of paper equity`)),
  );
}

function renderTickets(d) {
  const box = $('#tickets');
  if (!d.tickets.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'No ticket passed the risk and liquidity guards in this run. The desk stays flat.'));
    return;
  }
  box.replaceChildren(...d.tickets.map((t) => {
    const state = blotter[t.id]?.state;
    const blocked = t.status !== 'AWAITING_CONFIRMATION';
    const decide = (stateName) => () => {
      blotter[t.id] = { state: stateName, at: new Date().toISOString(), ticket: t };
      writeBlotter(blotter);
      renderTickets(d);
      renderBlotter(d);
    };
    return h('article', { class: `card ticket ${t.side}` },
      h('div', { class: 'ticket-head' },
        h('div', {}, h('b', {}, `${t.side} ${t.symbol}`), h('div', { class: 'muted small' }, `${t.label} · ${t.venue}`)),
        h('span', { class: `pill ${blocked ? 'BLOCKED' : t.side}` }, blocked ? 'Blocked' : state ? state : 'Awaiting you')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Notional'), h('dd', {}, fmt.usd(t.notional)),
        t.estAvgPrice ? [h('dt', {}, 'Est. avg fill'), h('dd', {}, fmt.px(t.estAvgPrice))] : null,
        t.limitPrice ? [h('dt', {}, 'Limit (IOC)'), h('dd', {}, fmt.px(t.limitPrice))] : null,
        t.quantity ? [h('dt', {}, 'Quantity'), h('dd', {}, (+t.quantity).toPrecision(4))] : null,
        Number.isFinite(t.slippageBps) ? [h('dt', {}, 'Spread / slippage'), h('dd', {}, `${t.spreadBps} / ${t.slippageBps} bps`)] : null,
        t.stopPrice ? [h('dt', {}, 'Stop'), h('dd', {}, `${fmt.px(t.stopPrice)} (${(t.stopPct * 100).toFixed(1)}%)`)] : null,
        t.maxLoss ? [h('dt', {}, 'Max loss at stop'), h('dd', {}, fmt.usd(t.maxLoss))] : null),
      blocked ? h('ul', { class: 'guards' }, t.reasons.map((r) => h('li', {}, r))) : null,
      blocked ? null : h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: decide('Confirmed (paper)'), disabled: !!state }, 'Confirm (paper)'),
        h('button', { class: 'btn', onclick: decide('Rejected'), disabled: !!state }, 'Reject')),
    );
  }));
}

const FACTOR_LABEL = { flow: 'ETF flows', momentum: 'Momentum', sector: 'Sector', news: 'News', regime: 'Regime' };
const FACTOR_ORDER = { major: ['flow', 'momentum', 'news', 'regime'], index: ['momentum', 'sector', 'news', 'regime'] };

function sparkline(points) {
  const svg = svgEl('svg', { class: 'spark', viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(svgEl('line', { x1: 0, x2: 100, y1: 15, y2: 15 }));
  if (points.length > 1) {
    const step = 100 / (points.length - 1);
    const dPath = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(2)},${(15 - p * 14).toFixed(2)}`).join(' ');
    svg.append(svgEl('path', { d: dPath, 'vector-effect': 'non-scaling-stroke' }));
  }
  return svg;
}

let currentFilter = 'all';
function renderSignals(d, history) {
  const series = {};
  for (const r of history?.runs ?? []) for (const s of r.signals) (series[s.id] ??= []).push(s.score);
  const list = d.assets.filter((a) => {
    if (currentFilter === 'action') return a.signal.stance === 'BUY' || a.signal.stance === 'SELL';
    if (currentFilter === 'major' || currentFilter === 'index') return a.kind === currentFilter;
    return true;
  });
  $('#signals').replaceChildren(...list.map((a) => {
    const f = a.factors;
    const ev = f.news?.evidence ?? [];
    const pts = series[a.id] ?? [];
    return h('article', { class: 'card sig' },
      h('div', { class: 'sig-head' },
        h('div', {}, h('h3', {}, a.label),
          h('div', { class: 'sub' }, `${a.kind === 'major' ? 'Major' : 'SoSoValue SSI index'} · ${a.venue ? `${a.venue.symbol} on SoDEX ${a.venue.market}` : 'no SoDEX market (watchlist)'}`)),
        h('span', { class: `pill ${a.signal.stance === 'NO DATA' ? 'NONE' : a.signal.stance}` }, a.signal.stance)),
      h('div', { class: 'score-row num' },
        h('span', {}, `Score ${fmt.signed(a.signal.score)}`), scoreBar(a.signal.score), h('span', {}, `conf ${Math.round(a.signal.confidence * 100)}%`)),
      h('div', { class: 'factors num' }, FACTOR_ORDER[a.kind].map((k) => {
        const x = f[k];
        if (!x) return null;
        return [h('span', {}, FACTOR_LABEL[k]),
          x.available === false ? h('span', { class: 'na' }, x.note) : [scoreBar(x.score), h('span', {}, fmt.signed(x.score))]];
      })),
      h('div', { class: 'explain' },
        h('p', {}, h('b', {}, a.explain.summary)),
        h('p', {}, a.explain.why),
        h('p', { class: 'risk' }, a.explain.risk)),
      a.decision?.guards?.length && a.decision.action === 'BLOCKED'
        ? h('ul', { class: 'guards' }, a.decision.guards.map((g) => h('li', {}, `Guard: ${g}`)))
        : null,
      pts.length > 1 ? [h('div', { class: 'muted small' }, `Score over the last ${pts.length} runs`), sparkline(pts.slice(-40))] : null,
      ev.length ? h('details', {},
        h('summary', {}, `Evidence (${ev.length} of ${f.news.articles} articles)`),
        h('ul', { class: 'evidence' }, ev.map((e) => h('li', {},
          h('span', { class: `dot ${e.sentiment > 0 ? 'pos' : e.sentiment < 0 ? 'neg' : 'neu'}` }),
          h('span', {}, e.url && /^https:\/\//.test(e.url) ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title) : e.title,
            h('span', { class: 'muted' }, ` · ${e.ageHours}h ago · ${fmt.signed(e.sentiment)}`)))))) : null,
    );
  }));
}

function table(headers, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map(([t, cls]) => h('th', { class: cls }, t)))),
    h('tbody', {}, rows)));
}

function renderTrack(d) {
  const t = d.track;
  if (!t.tickets) {
    $('#track').replaceChildren(h('div', { class: 'empty' }, 'The track record starts after the first ticket is proposed; it fills in automatically on every scheduled run.'));
    return;
  }
  $('#track').replaceChildren(
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { class: t.pnl >= 0 ? 'up' : 'down' }, fmt.usd(t.pnl)), h('span', {}, 'paper P&L')),
      h('div', { class: 'stat' }, h('b', {}, String(t.tickets)), h('span', {}, 'tickets marked')),
      h('div', { class: 'stat' }, h('b', {}, t.hitRate === null ? '—' : `${t.hitRate}%`), h('span', {}, 'hit rate'))),
    table([['Opened'], ['Ticket'], ['Entry', 'num'], ['Mark', 'num'], ['Return', 'num']], t.rows.map((r) => h('tr', {},
      h('td', {}, fmt.ago(r.openedAt)),
      h('td', {}, `${r.side} ${r.symbol}${r.stopped ? ' (stopped)' : ''}`),
      h('td', { class: 'num' }, fmt.px(r.entry)),
      h('td', { class: 'num' }, fmt.px(r.mark)),
      h('td', { class: `num ${r.returnPct >= 0 ? 'up' : 'down'}` }, `${r.returnPct >= 0 ? '+' : ''}${r.returnPct}%`)))),
  );
}

function renderBlotter(d) {
  const entries = Object.values(blotter).filter((e) => e.state === 'Confirmed (paper)');
  if (!entries.length) {
    $('#blotter').replaceChildren(h('div', { class: 'empty' }, 'Confirm a ticket above to start a paper position on this device.'));
    return;
  }
  const mark = Object.fromEntries(d.tickets.map((t) => [t.symbol, t.mid]));
  for (const r of d.track.rows) mark[r.symbol] ??= r.mark;
  $('#blotter').replaceChildren(
    table([['Confirmed'], ['Ticket'], ['Fill', 'num'], ['Now', 'num'], ['P&L', 'num']], entries.map((e) => {
      const t = e.ticket;
      const now = mark[t.symbol];
      const dir = t.side === 'BUY' ? 1 : -1;
      const pnl = Number.isFinite(now) ? (dir * (now - t.estAvgPrice) / t.estAvgPrice) * t.notional : NaN;
      return h('tr', {},
        h('td', {}, fmt.ago(e.at)), h('td', {}, `${t.side} ${t.symbol}`),
        h('td', { class: 'num' }, fmt.px(t.estAvgPrice)), h('td', { class: 'num' }, fmt.px(now)),
        h('td', { class: `num ${pnl >= 0 ? 'up' : 'down'}` }, Number.isFinite(pnl) ? fmt.usd(pnl) : '—'));
    })),
    h('p', {}, h('button', { class: 'btn', onclick: () => { blotter = {}; writeBlotter(blotter); renderBlotter(d); renderTickets(d); } }, 'Clear my blotter')),
  );
}

function renderRisk(d) {
  const m = d.macro;
  const c = d.sizing.config;
  $('#risk').replaceChildren(
    h('div', { class: 'box' }, h('b', {}, 'Macro risk'), `${Math.round(m.risk * 100)}%`, h('div', { class: 'meter' }, h('i', { style: `width:${m.risk * 100}%` })), h('p', { class: 'small muted' }, m.note)),
    h('div', { class: 'box' }, h('b', {}, 'Next FOMC'), m.nextMeeting ? `${m.nextMeeting.date} · ${m.nextMeeting.probability}% on ${m.nextMeeting.mostLikelyRange} bps` : 'n/a',
      h('p', { class: 'small muted' }, 'Confidence is cut when odds are below 70% or the meeting is within 2 days.')),
    h('div', { class: 'box' }, h('b', {}, 'Position sizing'), `${c.riskPerTrade * 100}% of ${fmt.usd(c.equity, 0)} at risk per idea`,
      h('p', { class: 'small muted' }, `Stops ${c.minStopPct * 100}–${c.maxStopPct * 100}% from 1.5× daily range · max ${c.maxPosition * 100}% per position · ${c.maxGrossExposure * 100}% gross cap`)),
    h('div', { class: 'box' }, h('b', {}, 'Execution guards'), 'Max 30 bps slippage · ≥98% fillable',
      h('p', { class: 'small muted' }, 'No shorts on spot markets · new longs paused when macro risk > 75% · human confirmation on every ticket')),
  );
}

async function load() {
  try {
    const bust = `?t=${Math.floor(Date.now() / 60000)}`;
    const [d, history] = await Promise.all([
      fetch(`data/latest.json${bust}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      fetch(`data/history.json${bust}`).then((r) => (r.ok ? r.json() : { runs: [] })).catch(() => ({ runs: [] })),
    ]);
    renderMeta(d);
    renderBrief(d);
    renderTickets(d);
    renderSignals(d, history);
    renderTrack(d);
    renderBlotter(d);
    renderRisk(d);
    document.querySelectorAll('.filters .chip').forEach((b) => b.addEventListener('click', () => {
      currentFilter = b.dataset.filter;
      document.querySelectorAll('.filters .chip').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      renderSignals(d, history);
    }));
  } catch (e) {
    $('#brief').replaceChildren(h('p', {}, `Could not load the latest agent run (${e.message}).`));
  }
}

load();

'use strict';

/* ── Small helpers ────────────────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: 'dashboard',
  status: null,
  signals: [],
  funnel: {},
  gateOrder: [],
  trades: [],
  tradeFilter: '',
  expandedSignal: null,
  logSeq: 0,
  schema: null,
  settings: null,
  overridden: [],
  pollTimer: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(n, dp = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(dp);
}

function fmtUsd(n, dp = 4) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(dp)}`;
}

function fmtCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch (e) {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
  } catch (e) {
    return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
  }
}

function fmtDateFull(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour12: false });
  } catch (e) {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function sgn(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: 'Server returned an unreadable response.' }));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ── Status bar ───────────────────────────────────────────────────────────────────────── */

function renderStatus(s) {
  const set = (field, text, cls = '') => {
    const el = $(`[data-field="${field}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = `stat-value ${cls}`;
  };

  const mode = s.mode === 'live' ? (s.testnet ? 'LIVE·TEST' : 'LIVE·REAL') : 'PAPER';
  set('mode', mode, s.mode === 'live' ? 'live' : 'paper');
  set('engine', s.running ? (s.scanning ? 'SCANNING' : 'RUNNING') : 'STOPPED', s.running ? 'on' : 'off');
  set('regime', s.btcRegime?.regime || '—');
  set('open', `${s.summary.open}+${s.summary.pending}`);
  // Closed realised stays the primary NET P&L. When anything is open, append floating total
  // so you are not blind until close (e.g. "-2.92  float -0.41").
  const closedNet = s.summary.netPnl;
  const float = state.openUnrealisedPnl;
  if (s.summary.open > 0 && float != null && Number.isFinite(Number(float))) {
    const el = $('[data-field="netpnl"]');
    if (el) {
      el.innerHTML = `${fmtUsd(closedNet)} <span class="faint ${sgn(float)}">float ${fmtUsd(float)}</span>`;
      el.className = `stat-value ${sgn(closedNet)}`;
    }
  } else {
    set('netpnl', fmtUsd(closedNet), sgn(closedNet));
  }
  set('today', fmtUsd(s.summary.todayPnl), sgn(s.summary.todayPnl));

  $('#btnStart').disabled = s.running;
  $('#btnStop').disabled = !s.running;

  // Banner: surface anything that means "the engine will not trade right now".
  const banner = $('#banner');
  const notes = [];
  let danger = false;

  if (!s.running) {
    const why = s.stopReason ? ` Reason: ${s.stopReason}.` : '';
    const when = s.stoppedAt ? ` Stopped ${fmtTime(s.stoppedAt)} UTC.` : '';
    notes.push(`Engine is STOPPED.${why}${when}`);
    danger = true;
  }
  if (s.killSwitch) { notes.push('Kill switch is engaged — no new orders will be placed.'); danger = true; }
  if (s.haltedUntil && Date.now() < s.haltedUntil) {
    notes.push(`Circuit breaker halted trading: ${s.haltReason} Resumes ${fmtTime(s.haltedUntil)} UTC.`);
    danger = true;
  }
  if (!s.tradingEnabled) notes.push('Trading is switched off — the engine is scanning and recording only.');
  if (s.mode === 'live' && !s.testnet) { notes.push('LIVE MAINNET: orders use real funds.'); danger = true; }
  if (s.mode === 'live' && !s.apiKeySet) { notes.push('Live mode is selected but no Bybit API credentials are set on the server.'); danger = true; }
  if (s.lastError) { notes.push(`Last scan error: ${s.lastError}`); danger = true; }

  if (notes.length) {
    banner.hidden = false;
    banner.className = `banner${danger ? ' danger' : ''}`;
    banner.textContent = notes.join('  ·  ');
  } else {
    banner.hidden = true;
  }
}

/* ── Gate funnel ──────────────────────────────────────────────────────────────────────── */

function renderFunnel() {
  const el = $('#funnel');
  const f = state.funnel;
  if (!f || !f.evaluated) {
    el.innerHTML = '<div class="empty">Run a scan to see the funnel.</div>';
    return;
  }

  const gated = f.gated || {};

  function killsFor(gateName) {
    let n = 0;
    for (const [k, v] of Object.entries(gated)) {
      if (k === gateName || k.endsWith(':' + gateName)) n += Number(v) || 0;
    }
    return n;
  }

  // Rebuild: count attempts that reached gate evaluation
  const gateOrder = state.gateOrder || [];
  const gateKillTotal = gateOrder.reduce((a, g) => a + killsFor(g), 0);
  const reachedGates = (f.passed || 0) + gateKillTotal;
  const noSignal = f.noSignal != null ? f.noSignal : Math.max(0, (f.dual ? f.evaluated * 2 : f.evaluated) - reachedGates);

  const stages = [];
  const scanned = f.evaluated;
  stages.push({ name: 'Symbols scanned', count: scanned, killed: 0, enabled: true });
  stages.push({
    name: 'Engine attempts w/ setup',
    count: reachedGates,
    killed: noSignal,
    enabled: true,
  });

  let cursor = reachedGates;
  for (const g of gateOrder) {
    const k = killsFor(g);
    const enabled = isGateEnabled(g);
    cursor = Math.max(0, cursor - k);
    stages.push({ name: g.replace(/_/g, ' '), count: cursor, killed: k, enabled });
  }
  stages.push({ name: 'Passed all gates', count: f.passed || 0, killed: 0, enabled: true });
  stages.push({ name: 'Placed', count: f.placed || 0, killed: 0, enabled: true, terminal: true });

  const top = Math.max(1, scanned, reachedGates, f.passed || 0);

  // Top rejection reasons (raw) so dual prefixes are visible
  const topRejects = Object.entries(gated)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `<div class="funnel-reject"><span>${esc(k)}</span><span>−${v}</span></div>`)
    .join('');

  el.innerHTML = stages.map((s) => `
    <div class="funnel-stage${s.enabled ? '' : ' disabled'}${s.terminal ? ' terminal' : ''}">
      <div class="funnel-name">${esc(s.name)}</div>
      <div class="funnel-count">${s.count}</div>
      <div class="funnel-killed ${s.killed ? '' : 'none'}">${s.killed ? `−${s.killed}` : (s.enabled ? '—' : 'off')}</div>
      <div class="funnel-bar"><span style="width:${Math.min(100, (s.count / top) * 100)}%"></span></div>
    </div>
  `).join('') + (topRejects ? `<div class="funnel-rejects"><div class="funnel-rejects-title">Top rejects (last scan)</div>${topRejects}</div>` : '');
}

function isGateEnabled(gateName) {
  const s = state.settings;
  if (!s) return true;
  const map = {
    SCORE_BAND: 'gateScoreBandEnabled',
    TURNOVER_GATE: 'gateTurnoverEnabled',
    RR_BOUNDS: 'gateRREnabled',
    COST_FLOOR: 'gateCostFloorEnabled',
    SL_DISTANCE: 'gateSlDistEnabled',
    BTC_REGIME: 'gateBtcRegimeEnabled',
    SPREAD: 'gateSpreadEnabled',
    VOLUME_GATE: 'gateVolumeEnabled',
    FUNDING_GATE: 'gateFundingEnabled',
  };
  const key = map[gateName];
  return key ? Boolean(s[key]) : true;
}

/* ── Dashboard metrics ────────────────────────────────────────────────────────────────── */

function renderMetrics(s) {
  const m = s.summary;
  const items = [
    ['Closed trades', m.totalClosed, ''],
    ['Win rate', m.winRate == null ? '—' : `${fmt(m.winRate, 1)}%`, ''],
    ['Net P&L', fmtUsd(m.netPnl), sgn(m.netPnl)],
    ['Expectancy', m.expectancy == null ? '—' : fmtUsd(m.expectancy), sgn(m.expectancy)],
    ['Profit factor', m.profitFactor == null ? '—' : fmt(m.profitFactor, 2), ''],
    ['Max drawdown', fmtUsd(-Math.abs(m.maxDrawdown)), m.maxDrawdown ? 'neg' : ''],
    ['Losses in a row', m.consecLosses, m.consecLosses >= 3 ? 'neg' : ''],
    ['Expired entries', m.expired, ''],
  ];
  $('#metrics').innerHTML = items.map(([label, value, cls]) => `
    <div>
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-value ${cls}">${esc(value)}</div>
    </div>
  `).join('');
}

async function renderAccount() {
  const el = $('#account');
  try {
    const a = await api('/api/account');
    if (!a.ok) {
      el.innerHTML = `<div class="metric-note">${esc(a.reason)}</div>`;
      return;
    }
    const items = [
      ['Equity', fmt(a.totalEquity, 2)],
      ['Available', fmt(a.availableBalance, 2)],
      ['Unrealised', fmtUsd(a.unrealisedPnl, 2)],
      ['Network', a.testnet ? 'Testnet' : 'Mainnet'],
    ];
    el.innerHTML = items.map(([l, v]) => `
      <div><div class="metric-label">${esc(l)}</div><div class="metric-value">${esc(v)}</div></div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<div class="metric-note">${esc(e.message)}</div>`;
  }
}

/* ── Positions ────────────────────────────────────────────────────────────────────────── */

function renderLivePositions() {
  const live = state.trades.filter((t) => ['PENDING', 'OPEN'].includes(t.status));
  const el = $('#livePositions');
  if (!live.length) {
    el.innerHTML = '<div class="empty">Nothing open.</div>';
    return;
  }
  el.innerHTML = `
    <div class="rows">
      <div class="row row-pos row-head">
        <div>Symbol</div><div>Side</div><div>State</div><div>Entry</div>
        <div>Stop</div><div>Target</div><div>Qty</div><div>Float</div>
      </div>
      ${live.map((t) => {
        const float = t.status === 'OPEN' && t.unrealisedPnl != null ? t.unrealisedPnl : null;
        return `
        <div class="row row-pos">
          <div class="sym">${esc(t.symbol)}</div>
          <div class="side-${t.side.toLowerCase()}">${esc(t.side)}</div>
          <div><span class="pill ${t.status === 'OPEN' ? 'open' : 'pending'}">${esc(t.status)}</span></div>
          <div>${fmt(t.fillPrice ?? t.plannedEntry, 6)}</div>
          <div class="dim">${fmt(t.sl, 6)}</div>
          <div class="dim">${fmt(t.tp, 6)}</div>
          <div class="dim">${fmt(t.qty, 4)}</div>
          <div class="${sgn(float)}">${float == null ? '—' : fmtUsd(float)}</div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ── Signals ──────────────────────────────────────────────────────────────────────────── */

function renderSignals() {
  const el = $('#signalList');
  if (!state.signals.length) {
    el.innerHTML = '<div class="empty">No setups found in the last scan.</div>';
    return;
  }
  el.innerHTML = `
    <div class="rows">
      <div class="row row-signal row-head">
        <div>Time (LK)</div><div>Symbol</div><div>Side</div><div>Score</div><div>RR</div>
        <div>Stop %</div><div>Path</div><div>Verdict</div>
      </div>
      ${state.signals.map((sig) => {
        const passed = sig.gates?.passed;
        const failed = sig.gates?.failed || [];
        const verdict = passed
          ? '<span class="pill pass">Passed</span>'
          : `<span class="pill fail">${esc(failed[0] || 'blocked')}</span>${failed.length > 1 ? ` <span class="faint">+${failed.length - 1}</span>` : ''}`;
        const open = state.expandedSignal === sig.id;
        const path = sig.entryPath || sig.structureEvent || '—';
        const ts = sig.createdAt || sig.scanAt || null;
        return `
          <div class="row row-signal row-clickable" data-signal="${esc(sig.id)}">
            <div class="faint" data-label="Time (LK)">${fmtDate(ts)}</div>
            <div class="sym" data-label="Symbol">${esc(sig.symbol)}</div>
            <div class="side-${sig.side.toLowerCase()}" data-label="Side">${esc(sig.side)}</div>
            <div data-label="Score">${sig.score}</div>
            <div data-label="RR (planned)">${fmt(sig.rr, 2)}</div>
            <div class="dim" data-label="Stop %">${fmt(sig.slDistPct, 2)}</div>
            <div class="dim" data-label="Path">${esc(String(path).slice(0, 18))}</div>
            <div data-label="Verdict">${verdict}</div>
          </div>
          ${open ? renderSignalDetail(sig) : ''}
        `;
      }).join('')}
    </div>`;
}

function renderSignalDetail(sig) {
  const c = sig.components || {};
  const q = sig.quality || {};
  const checks = sig.gates?.checks || [];
  const m = sig.market || {};
  const ts = sig.createdAt || sig.scanAt || null;
  return `
    <div class="detail">
      <div class="detail-grid">
        <div>
          <h4>Plan</h4>
          <div class="kv"><span>Created (LK)</span><span>${fmtDateFull(ts)}</span></div>
          <div class="kv"><span>Timeframe</span><span>${esc(sig.timeframe || '—')}m</span></div>
          <div class="kv"><span>Entry</span><span>${fmt(sig.entry, 6)}</span></div>
          <div class="kv"><span>Stop</span><span>${fmt(sig.sl, 6)}</span></div>
          <div class="kv"><span>Target</span><span>${fmt(sig.tp, 6)}</span></div>
          <div class="kv"><span>Last price</span><span>${fmt(sig.price, 6)}</span></div>
          <div class="kv"><span>ATR</span><span>${fmt(sig.atr, 6)}</span></div>
          <div class="kv"><span>Stop distance</span><span>${fmt(sig.slDistPct, 3)}%</span></div>
          <div class="kv"><span>Planned RR</span><span>${fmt(sig.rr, 2)}</span></div>
        </div>
        <div>
          <h4>Score ${sig.score}</h4>
          <div class="kv"><span>Trend</span><span>${c.trend ?? '—'} pts</span></div>
          <div class="kv"><span>Pullback / structure</span><span>${c.pullback ?? c.structure ?? '—'} pts</span></div>
          <div class="kv"><span>Momentum</span><span>${c.momentum ?? '—'} pts</span></div>
          <div class="kv"><span>Location</span><span>${c.location ?? '—'} pts</span></div>
          <div class="kv"><span>Reward:risk</span><span>${c.rr ?? '—'} pts</span></div>
          <div class="kv"><span>Regime multiplier</span><span>${fmt(c.regimeMultiplier, 2)}</span></div>
        </div>
        <div>
          <h4>Context</h4>
          <div class="kv"><span>Engine</span><span>${esc(sig.engine || '—')}</span></div>
          <div class="kv"><span>Entry path</span><span>${esc(sig.entryPath || '—')}</span></div>
          <div class="kv"><span>Path reason</span><span>${esc(sig.entryPathReason || '—')}</span></div>
          <div class="kv"><span>Structure event</span><span>${esc(sig.structureEvent || '—')}</span></div>
          <div class="kv"><span>Structure trend</span><span>${esc(sig.structureTrend || '—')}</span></div>
          <div class="kv"><span>BTC regime</span><span>${esc(sig.btcRegime || '—')}</span></div>
          <div class="kv"><span>Regime aligned</span><span>${sig.regimeAligned == null ? '—' : sig.regimeAligned ? 'yes' : 'no'}</span></div>
          <div class="kv"><span>RSI</span><span>${fmt(c.rsi, 1)}</span></div>
          <div class="kv"><span>Volume ratio</span><span>${fmt(c.volumeRatio ?? m.volRatio, 2)}</span></div>
          <div class="kv"><span>Spread</span><span>${m.spreadPct == null ? '—' : `${fmt(m.spreadPct, 4)}%`}</span></div>
          <div class="kv"><span>Funding</span><span>${Number(m.fundingRate ?? 0).toExponential(2)}</span></div>
          <div class="kv"><span>24h turnover</span><span>${fmtCompact(m.turnover24h)}</span></div>
          <div class="kv"><span>Trend strength</span><span>${q.trendStrength != null ? fmt(q.trendStrength, 1) : '—'}</span></div>
        </div>
        <div style="grid-column: 1 / -1">
          <h4>Gate verdicts</h4>
          ${checks.map((ch) => `
            <div class="gate-line">
              <span class="pill ${ch.enabled ? (ch.pass ? 'pass' : 'fail') : 'off'}">${ch.enabled ? (ch.pass ? 'pass' : 'fail') : 'off'}</span>
              <span>${esc(ch.name)}</span>
              <span class="gate-detail">${esc(ch.detail)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>`;
}

/* ── Trades ───────────────────────────────────────────────────────────────────────────── */

function renderTrades() {
  const el = $('#tradeList');
  let list = state.tradeFilter
    ? state.trades.filter((t) => t.status === state.tradeFilter)
    : state.trades.slice();
  if (state.hideExpired && state.tradeFilter !== 'EXPIRED') list = list.filter((t) => t.status !== 'EXPIRED');

  if (!list.length) {
    el.innerHTML = '<div class="empty">No trades match this filter.</div>';
    return;
  }
  el.innerHTML = `
    <div class="rows">
      <div class="row row-trade row-head">
        <div>Created (LK)</div><div>Engine</div><div>Symbol</div><div>Side</div><div>Status</div>
        <div>Net USDT</div><div>R</div><div>Entry</div><div>Closed</div>
      </div>
      ${list.map((t) => {
        const created = t.createdAt || t.filledAt || null;
        const eng = t.engine || t.entryPath || (t.structureEvent === 'TREND_PULLBACK' ? 'TREND' : (Math.abs((t.plannedRR||0)-2)<1e-6 ? 'TREND' : 'STRUCTURE'));
        // OPEN: show live floating (mark-to-market) P&L; CLOSED: realised net; PENDING: —
        const isOpen = t.status === 'OPEN';
        const pnl = isOpen
          ? (t.unrealisedPnl != null ? t.unrealisedPnl : null)
          : (t.netPnl != null ? t.netPnl : null);
        const rr = isOpen
          ? (t.unrealisedRR != null ? t.unrealisedRR : null)
          : (t.realisedRR != null ? t.realisedRR : null);
        const pnlLabel = isOpen && pnl != null ? 'Float' : 'Net USDT';
        return `
        <div class="row row-trade">
          <div class="faint" data-label="Created (LK)">${fmtDate(created)}</div>
          <div class="dim" data-label="Engine">${esc(String(eng))}</div>
          <div class="sym" data-label="Symbol">${esc(t.symbol)}</div>
          <div class="side-${t.side.toLowerCase()}" data-label="Side">${esc(t.side)}</div>
          <div data-label="Status"><span class="pill ${t.status === 'OPEN' ? 'open' : t.status === 'PENDING' ? 'pending' : ''}">${esc(t.status)}</span></div>
          <div class="${sgn(pnl)}" data-label="${pnlLabel}">${pnl == null ? '—' : fmtUsd(pnl)}${isOpen && pnl != null ? ' <span class="faint">live</span>' : ''}</div>
          <div class="${sgn(rr)}" data-label="R">${rr == null ? '—' : fmt(rr, 2)}</div>
          <div class="dim" data-label="Entry">${fmt(t.fillPrice ?? t.plannedEntry, 6)}</div>
          <div class="faint" data-label="Closed">${t.closedAt ? fmtDate(t.closedAt) : (isOpen && t.markPrice ? `m ${fmt(t.markPrice, 6)}` : '—')}</div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ── Settings ─────────────────────────────────────────────────────────────────────────── */

function renderSettings() {
  const el = $('#settingsForm');
  if (!state.schema) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }

  const groups = {};
  for (const spec of state.schema) {
    (groups[spec.group] ||= []).push(spec);
  }

  el.innerHTML = Object.entries(groups).map(([group, specs]) => `
    <div class="settings-group">
      <h3>${esc(group)}</h3>
      <div class="settings-body">
        ${specs.map((spec) => renderField(spec)).join('')}
      </div>
    </div>
  `).join('');

  $$('[data-setting]', el).forEach((input) => {
    input.addEventListener('change', onSettingChange);
  });
}

function renderField(spec) {
  const value = state.settings[spec.key];
  const pinned = state.overridden.includes(spec.key);
  let control;

  if (spec.type === 'bool') {
    control = `
      <label class="toggle">
        <input type="checkbox" data-setting="${esc(spec.key)}" data-type="bool" ${value ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>`;
  } else if (spec.type === 'enum') {
    control = `
      <select data-setting="${esc(spec.key)}" data-type="enum">
        ${spec.options.map((o) => `<option value="${esc(o)}" ${String(value) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
  } else if (spec.type === 'csv') {
    control = '';
  } else {
    const step = spec.type === 'int' ? '1' : 'any';
    control = `<input type="number" step="${step}" data-setting="${esc(spec.key)}" data-type="${esc(spec.type)}" value="${esc(value)}">`;
  }

  const help = spec.help
    ? `<div class="field-help">${spec.help.replace(/(VALIDATED|OFF by default)/g, '<strong>$1</strong>')}</div>`
    : '';

  const csvInput = spec.type === 'csv'
    ? `<input type="text" data-setting="${esc(spec.key)}" data-type="csv" value="${esc(value)}" placeholder="BTCUSDT, ETHUSDT">`
    : '';

  return `
    <div class="field">
      <div class="field-top">
        <span class="field-label">${pinned ? '<span class="pin-dot" title="Pinned by you"></span>' : ''}${esc(spec.label)}</span>
        ${control}
      </div>
      ${csvInput}
      ${help}
    </div>`;
}

async function onSettingChange(e) {
  const el = e.target;
  const key = el.dataset.setting;
  const type = el.dataset.type;
  let value;

  if (type === 'bool') value = el.checked;
  else if (type === 'int' || type === 'float') value = Number(el.value);
  else value = el.value;

  // Going live with real funds is the one action that should never happen on a stray click.
  if (key === 'mode' && value === 'live') {
    const testnet = state.settings.testnet;
    const warning = testnet
      ? 'Switch to live mode on TESTNET? Orders will be sent to Bybit testnet.'
      : 'Switch to LIVE MAINNET? Orders will use real funds.';
    if (!confirm(warning)) { el.value = state.settings.mode; return; }
  }
  if (key === 'testnet' && value === false) {
    if (!confirm('Turn off testnet? Live mode will then trade with real funds on Bybit mainnet.')) {
      el.checked = true;
      return;
    }
  }

  try {
    const res = await api('/api/settings', { method: 'POST', body: { [key]: value } });
    state.settings = res.settings;
    state.overridden = res.overridden;
    if (res.fixes && res.fixes.length) res.fixes.forEach((f) => toast(f, 'warn'));
    else toast(`Saved ${key}`);
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Logs ─────────────────────────────────────────────────────────────────────────────── */

async function pollLogs() {
  try {
    const res = await api(`/api/logs?after=${state.logSeq}`);
    if (!res.logs.length) return;
    state.logSeq = res.logs[res.logs.length - 1].seq;
    const stream = $('#logStream');
    const wasAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;

    stream.insertAdjacentHTML('beforeend', res.logs.map((l) => `
      <div class="log-line ${esc(l.level)}">
        <span class="log-ts">${fmtTime(l.ts)}</span>
        <span class="log-scope">${esc(l.scope)}</span>
        <span class="log-msg">${esc(l.msg)}</span>
      </div>
    `).join(''));

    while (stream.children.length > 800) stream.removeChild(stream.firstChild);
    if ($('#logFollow').checked && wasAtBottom) stream.scrollTop = stream.scrollHeight;
  } catch (_e) { /* logs are non-critical */ }
}

/* ── Polling ──────────────────────────────────────────────────────────────────────────── */

async function refresh() {
  try {
    const [status, signals, trades] = await Promise.all([
      api('/api/status'),
      api('/api/signals'),
      api(`/api/trades?limit=300`),
    ]);

    state.status = status;
    state.signals = signals.signals || [];
    state.funnel = signals.funnel || {};
    state.gateOrder = signals.gateOrder || [];
    state.trades = trades.trades || [];
    state.openUnrealisedPnl = trades.openUnrealisedPnl;

    renderStatus(status);
    if (state.view === 'dashboard') {
      renderFunnel();
      renderMetrics(status);
      renderLivePositions();
    }
    if (state.view === 'signals') renderSignals();
    if (state.view === 'trades') renderTrades();
  } catch (e) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.className = 'banner danger';
    banner.textContent = `Cannot reach the server: ${e.message}`;
  }
  await pollLogs();
}

/* ── Wiring ───────────────────────────────────────────────────────────────────────────── */

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  if (view === 'settings') loadSettings();
  if (view === 'dashboard') renderAccount();
  refresh();
}

async function loadSettings() {
  try {
    const res = await api('/api/settings');
    state.schema = res.schema;
    state.settings = res.settings;
    state.overridden = res.overridden;
    renderSettings();
  } catch (e) {
    $('#settingsForm').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function control(path, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    const res = await api(path, { method: 'POST' });
    if (res.errors && res.errors.length) {
      res.errors.forEach((err) => toast(err, 'error'));
    } else {
      toast('Done');
    }
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function init() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#btnStart').addEventListener('click', () => control('/api/control/start'));
  $('#btnStop').addEventListener('click', () => control('/api/control/stop'));
  $('#btnScan').addEventListener('click', () => control('/api/control/scan'));
  $('#btnPanic').addEventListener('click', () => control('/api/control/panic',
    'Close every open position and cancel every pending order now?'));

  // Both endpoints already existed but were never exposed, so the only apparent way to recover
  // from a stuck kill switch was a redeploy — which also wiped every in-flight BOS event.
  $('#btnReleaseKill').addEventListener('click', () => control('/api/control/release-kill',
    'Release the kill switch and allow new entries again?'));
  $('#btnClearHalt').addEventListener('click', () => control('/api/control/clear-halt',
    'Clear the circuit-breaker halt and all symbol lockouts?'));

  $('#btnResetAll').addEventListener('click', async () => {
    if (!confirm('Reset every setting back to its default?')) return;
    try {
      const res = await api('/api/settings/reset', { method: 'POST', body: {} });
      state.settings = res.settings;
      state.overridden = [];
      toast('All settings reset to defaults');
      await loadSettings();
    } catch (e) { toast(e.message, 'error'); }
  });

  const hideExpEl = $('#hideExpiredTrades');
  if (hideExpEl) {
    hideExpEl.checked = state.hideExpired !== false;
    hideExpEl.addEventListener('change', () => {
      state.hideExpired = !!hideExpEl.checked;
      renderTrades();
    });
  }
  $('#tradeFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.tradeFilter = chip.dataset.status;
    $$('.chip', $('#tradeFilters')).forEach((c) => c.classList.toggle('is-active', c === chip));
    renderTrades();
  });

  const downloadFrom = (path) => { window.location.href = path; };
  $('#btnExportTradesCsv').addEventListener('click', () => downloadFrom('/api/journal/trades/export?format=csv'));
  $('#btnExportTradesJson').addEventListener('click', () => downloadFrom('/api/journal/trades/export?format=json'));
  $('#btnExportSignalsCsv').addEventListener('click', () => downloadFrom('/api/journal/signals/export?format=csv'));
  $('#btnExportSignalsJson').addEventListener('click', () => downloadFrom('/api/journal/signals/export?format=json'));
  $('#btnClearSignals').addEventListener('click', async () => {
    if (!confirm('Clear ALL signal history and the live signals list? This cannot be undone.')) return;
    try {
      await api('/api/journal/signals/clear', { method: 'POST' });
      state.signals = [];
      state.funnel = {};
      renderSignals();
      alert('Signals cleared.');
    } catch (e) { alert('Failed: ' + (e.message || e)); }
  });
  $('#btnClearTrades').addEventListener('click', async () => {
    if (!confirm('Clear ALL trades (pending, open, closed, expired)? Paper positions will be wiped. This cannot be undone.')) return;
    try {
      await api('/api/journal/trades/clear', { method: 'POST' });
      state.trades = [];
      renderTrades();
      alert('Trades cleared.');
    } catch (e) { alert('Failed: ' + (e.message || e)); }
  });

  $('#signalList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-signal]');
    if (!row) return;
    state.expandedSignal = state.expandedSignal === row.dataset.signal ? null : row.dataset.signal;
    renderSignals();
  });

  refresh();
  renderAccount();
  state.pollTimer = setInterval(refresh, 5000);
  setInterval(renderAccount, 30000);
}

document.addEventListener('DOMContentLoaded', init);

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
  return new Date(ts).toISOString().slice(11, 19);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
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
  set('netpnl', fmtUsd(s.summary.netPnl), sgn(s.summary.netPnl));
  set('today', fmtUsd(s.summary.todayPnl), sgn(s.summary.todayPnl));

  $('#btnStart').disabled = s.running;
  $('#btnStop').disabled = !s.running;

  // Banner: surface anything that means "the engine will not trade right now".
  const banner = $('#banner');
  const notes = [];
  let danger = false;

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

  // Walk the gate order, subtracting each gate's kills to show the survivor count at every step.
  const gated = f.gated || {};
  const stages = [];
  let alive = f.evaluated;

  stages.push({ name: 'Scanned', count: alive, killed: 0, enabled: true });

  const noSignalKeys = ['NOT_ENOUGH_HISTORY', 'NO_PRICE', 'NO_ATR', 'NO_DIRECTION',
    'NO_SUPPORT_LEVEL', 'NO_RESISTANCE_LEVEL', 'INVALID_LEVELS', 'INVERTED_PLAN'];
  const noSignalKilled = noSignalKeys.reduce((a, k) => a + (gated[k] || 0), 0);
  alive -= noSignalKilled;
  stages.push({ name: 'Has setup', count: alive, killed: noSignalKilled, enabled: true });

  for (const g of state.gateOrder) {
    const killed = gated[g] || 0;
    const enabled = isGateEnabled(g);
    alive -= killed;
    stages.push({ name: g.replace(/_/g, ' '), count: Math.max(0, alive), killed, enabled });
  }

  stages.push({ name: 'Placed', count: f.placed || 0, killed: 0, enabled: true, terminal: true });

  const top = Math.max(1, f.evaluated);
  el.innerHTML = stages.map((s) => `
    <div class="funnel-stage${s.enabled ? '' : ' disabled'}${s.terminal ? ' terminal' : ''}">
      <div class="funnel-name">${esc(s.name)}</div>
      <div class="funnel-count">${s.count}</div>
      <div class="funnel-killed ${s.killed ? '' : 'none'}">${s.killed ? `−${s.killed}` : (s.enabled ? '—' : 'off')}</div>
      <div class="funnel-bar"><span style="width:${Math.min(100, (s.count / top) * 100)}%"></span></div>
    </div>
  `).join('');
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
        <div>Stop</div><div>Target</div><div>Qty</div>
      </div>
      ${live.map((t) => `
        <div class="row row-pos">
          <div class="sym">${esc(t.symbol)}</div>
          <div class="side-${t.side.toLowerCase()}">${esc(t.side)}</div>
          <div><span class="pill ${t.status === 'OPEN' ? 'open' : 'pending'}">${esc(t.status)}</span></div>
          <div>${fmt(t.fillPrice ?? t.plannedEntry, 6)}</div>
          <div class="dim">${fmt(t.sl, 6)}</div>
          <div class="dim">${fmt(t.tp, 6)}</div>
          <div class="dim">${fmt(t.qty, 4)}</div>
        </div>
      `).join('')}
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
        <div>Symbol</div><div>Side</div><div>Score</div><div>RR</div>
        <div>Stop %</div><div>Turnover</div><div>Verdict</div>
      </div>
      ${state.signals.map((sig) => {
        const passed = sig.gates?.passed;
        const failed = sig.gates?.failed || [];
        const verdict = passed
          ? '<span class="pill pass">Passed all gates</span>'
          : `<span class="pill fail">${esc(failed[0] || 'blocked')}</span>${failed.length > 1 ? ` <span class="faint">+${failed.length - 1}</span>` : ''}`;
        const open = state.expandedSignal === sig.id;
        return `
          <div class="row row-signal row-clickable" data-signal="${esc(sig.id)}">
            <div class="sym">${esc(sig.symbol)}</div>
            <div class="side-${sig.side.toLowerCase()}">${esc(sig.side)}</div>
            <div>${sig.score}</div>
            <div>${fmt(sig.rr, 2)}</div>
            <div class="dim">${fmt(sig.slDistPct, 2)}</div>
            <div class="dim">${fmtCompact(sig.market.turnover24h)}</div>
            <div>${verdict}</div>
          </div>
          ${open ? renderSignalDetail(sig) : ''}
        `;
      }).join('')}
    </div>`;
}

function renderSignalDetail(sig) {
  const c = sig.components || {};
  const checks = sig.gates?.checks || [];
  return `
    <div class="detail">
      <div class="detail-grid">
        <div>
          <h4>Plan</h4>
          <div class="kv"><span>Entry</span><span>${fmt(sig.entry, 6)}</span></div>
          <div class="kv"><span>Stop</span><span>${fmt(sig.sl, 6)}</span></div>
          <div class="kv"><span>Target</span><span>${fmt(sig.tp, 6)}</span></div>
          <div class="kv"><span>Last price</span><span>${fmt(sig.price, 6)}</span></div>
          <div class="kv"><span>ATR</span><span>${fmt(sig.atr, 6)}</span></div>
        </div>
        <div>
          <h4>Score ${sig.score}</h4>
          <div class="kv"><span>Trend</span><span>${c.trend ?? '—'} / 25</span></div>
          <div class="kv"><span>Structure</span><span>${c.structure ?? '—'} / 25</span></div>
          <div class="kv"><span>Momentum</span><span>${c.momentum ?? '—'} / 15</span></div>
          <div class="kv"><span>Location</span><span>${c.location ?? '—'} / 20</span></div>
          <div class="kv"><span>Reward:risk</span><span>${c.rr ?? '—'} / 15</span></div>
          <div class="kv"><span>Regime multiplier</span><span>${fmt(c.regimeMultiplier, 2)}</span></div>
        </div>
        <div>
          <h4>Context</h4>
          <div class="kv"><span>Structure event</span><span>${esc(sig.structureEvent)}</span></div>
          <div class="kv"><span>Structure trend</span><span>${esc(sig.structureTrend)}</span></div>
          <div class="kv"><span>BTC regime</span><span>${esc(sig.btcRegime)}</span></div>
          <div class="kv"><span>RSI</span><span>${fmt(c.rsi, 1)}</span></div>
          <div class="kv"><span>Volume ratio</span><span>${fmt(c.volumeRatio, 2)}</span></div>
          <div class="kv"><span>Spread</span><span>${sig.market.spreadPct == null ? '—' : `${fmt(sig.market.spreadPct, 4)}%`}</span></div>
          <div class="kv"><span>Funding</span><span>${Number(sig.market.fundingRate ?? 0).toExponential(2)}</span></div>
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
  const list = state.tradeFilter
    ? state.trades.filter((t) => t.status === state.tradeFilter)
    : state.trades;

  if (!list.length) {
    el.innerHTML = '<div class="empty">No trades match this filter.</div>';
    return;
  }
  el.innerHTML = `
    <div class="rows">
      <div class="row row-trade row-head">
        <div>Symbol</div><div>Side</div><div>Status</div><div>Entry</div>
        <div>Exit</div><div>R</div><div>Net P&L</div><div>Closed</div>
      </div>
      ${list.map((t) => `
        <div class="row row-trade">
          <div class="sym">${esc(t.symbol)}</div>
          <div class="side-${t.side.toLowerCase()}">${esc(t.side)}</div>
          <div><span class="pill ${t.status === 'OPEN' ? 'open' : t.status === 'PENDING' ? 'pending' : ''}">${esc(t.status)}</span></div>
          <div>${fmt(t.fillPrice ?? t.plannedEntry, 6)}</div>
          <div class="dim">${t.exitPrice ? fmt(t.exitPrice, 6) : '—'}</div>
          <div class="${sgn(t.realisedRR)}">${t.realisedRR == null ? '—' : fmt(t.realisedRR, 2)}</div>
          <div class="${sgn(t.netPnl)}">${t.netPnl == null ? '—' : fmtUsd(t.netPnl)}</div>
          <div class="faint">${t.closedAt ? fmtDate(t.closedAt) : '—'}</div>
        </div>
      `).join('')}
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

  $('#tradeFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.tradeFilter = chip.dataset.status;
    $$('.chip', $('#tradeFilters')).forEach((c) => c.classList.toggle('is-active', c === chip));
    renderTrades();
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

'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');

// Model A: the research seal is immutable; management has its own live watermark.
// No timers are stopped or recreated. A full snapshot requires zero obligations.
class Maintenance {
  constructor(hooks) {
    this.hooks = hooks;
    this.context = new AsyncLocalStorage();
    this.active = new Map();
    this.state = 'RUNNING';
    this.reason = null;
    this.sealedWatermark = null;
    this.fullSealed = false;
    this.flushState = 'IDLE';
    this.operation = null;
    let saved;
    try { saved = hooks.load(); }
    catch { this.state = 'FAILED'; this.reason = 'MAINTENANCE_FLAG_UNREADABLE'; return; }
    // Only undefined means absent. JSON null is an existing invalid control file.
    if (saved !== undefined) {
      const states = ['RUNNING','ENTERING','SEALED','EXITING','FAILED'];
      const identity = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      const valid = saved && typeof saved === 'object' && !Array.isArray(saved) &&
        states.includes(saved.state) && typeof saved.maintenance === 'boolean' &&
        saved.maintenance === (saved.state !== 'RUNNING') &&
        (!saved.maintenance || (identity(saved.maintenanceEpoch) && identity(saved.processBootId))) &&
        (saved.state !== 'RUNNING' || (!saved.sealedWatermark && !saved.fullSealed && !saved.fullWatermark)) &&
        (saved.state !== 'SEALED' || (saved.sealedWatermark && typeof saved.sealedWatermark.epoch === 'string' &&
          ['sequence','attempted','accepted','persisted','lost'].every(k => Number.isInteger(saved.sealedWatermark[k]) && saved.sealedWatermark[k] >= 0) &&
          saved.sealedWatermark.attempted === saved.sealedWatermark.accepted &&
          saved.sealedWatermark.accepted === saved.sealedWatermark.persisted && saved.sealedWatermark.lost === 0));
      if (!valid || saved.maintenance) {
        this.state = 'FAILED';
        this.reason = valid ? 'RESTART_REQUIRES_RESEAL' : 'MAINTENANCE_FLAG_INVALID';
      }
    }
  }
  fenced() { return this.state !== 'RUNNING'; }
  save() { this.hooks.save({ maintenance: this.fenced(), state: this.state, reason: this.reason,
    processBootId: require('./runtimeIdentity').processBootId, maintenanceEpoch: this.maintenanceEpoch || null, sealedWatermark: this.sealedWatermark }); }
  assertStart(lane) {
    if (lane === 'archive' && this.context.getStore()?.lane === 'archive') return;
    if (this.fenced() && lane !== 'management')
      throw Object.assign(Error('MAINTENANCE_FENCED:' + lane), { code: 'MAINTENANCE_FENCED', statusCode: 409 });
  }
  run(lane, name, fn) {
    this.assertStart(lane);
    const key = lane + ':' + name;
    this.active.set(key, (this.active.get(key) || 0) + 1);
    const release = () => {
      const n = this.active.get(key) - 1;
      n ? this.active.set(key, n) : this.active.delete(key);
    };
    return this.context.run({ lane }, () => {
      try {
        const value = fn();
        if (value?.then) return Promise.resolve(value).finally(release);
        release(); return value;
      } catch (e) { release(); throw e; }
    });
  }
  // A missed producer must invalidate the seal BEFORE persisting, never drop evidence.
  beforeAppend() {
    if (!this.fenced()) return;
    const lane = this.context.getStore()?.lane;
    if (this.state === 'SEALED' && (lane !== 'management' || this.fullSealed)) {
      this.state = 'FAILED'; this.fullSealed = false;
      this.reason = 'UNEXPECTED_APPEND_AFTER_SEAL:' + (lane || 'untracked');
      try { this.save(); } catch { this.reason += ':FLAG_PUBLICATION_FAILED'; }
    }
  }
  watermark(c) {
    return { epoch: c.epochId, sequence: c.sequence, attempted: c.attemptedRows,
      accepted: c.acceptedRows, persisted: c.persistedRows, lost: c.lostRows };
  }
  status() {
    const detail = this.hooks.inspect();
    return { maintenance: this.fenced(), state: this.state, sealScope: 'RESEARCH_SEALED_MANAGEMENT_OPEN',
      admissionsFenced: this.fenced(), providersFenced: this.fenced(), archiveFenced: this.fenced(),
      activeSections: Object.fromEntries(this.active), ...detail,
      providerRecoveryPending: !!this.recoveryPending, providerRecoveryFailure: this.recoveryFailure || null,
      writerFlushState: this.flushState, sealedWatermark: this.sealedWatermark,
      managementWatermark: this.watermark(detail.capture), fullSealed: this.fullSealed,
      fullWatermark: this.fullWatermark || null,
      fullSymbolStatsVersion: this.fullSymbolStatsVersion ?? null,
      snapshotSafe: this.state === 'SEALED' && this.fullSealed && this.flushState === 'COMMITTED' && !this.reason &&
        this.fullBoundaryClean(detail) && !!this.fullWatermark &&
        this.fullSymbolStatsVersion === detail.symbolStats?.version &&
        Object.entries(this.watermark(detail.capture)).every(([key,value]) => this.fullWatermark[key] === value),
      reason: this.reason, timestamp: new Date().toISOString(), epoch: detail.capture.epochId };
  }
  fullBoundaryClean(d) {
    const c = d.capture, native = d.symbolStats || {};
    return !this.active.size && !this.recoveryPending && !this.recoveryFailure && !this.blockers(d).length &&
      !d.managementBusy && d.managementObligations.total === 0 &&
      !d.exportReaders && !d.archiveBuildActivity && !native.pending && !native.dirty && !native.failure &&
      !c.pendingRows && !c.pendingBytes && !d.journalBytes && !d.walFiles &&
      c.attemptedRows === c.acceptedRows && c.acceptedRows === c.persistedRows && c.lostRows === 0 &&
      !c.captureHalted && !c.pendingFailure;
  }
  async recoverProviders() {
    this.recoveryPending = true; this.recoveryFailure = null;
    try { await this.hooks.recoverProviders?.(); }
    catch (error) { this.recoveryFailure = 'PROVIDER_RECOVERY_FAILED:' + error.message; throw Error(this.recoveryFailure); }
    finally { this.recoveryPending = false; }
  }
  blockers(detail) {
    const names = [...this.active].filter(([k]) => !k.startsWith('management:')).map(([k,v]) => k + '=' + v);
    for (const [name,p] of Object.entries(detail.providers))
      if (p.queueDepth || p.inFlight || p.reserved || p.initializing || p.openRequests)
        names.push(name + ':' + JSON.stringify(p));
    if (!detail.archiveIdle) names.push('archive/export activity');
    if (detail.scanResearchBusy) names.push('scan/research producer busy');
    return names;
  }
  enter({ timeoutMs = 30000, retry = false } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw Object.assign(Error('INVALID_DRAIN_TIMEOUT'), { statusCode: 400 });
    if (this.operation) return this.operation;
    if (this.fenced() && !(retry === true && this.state === 'FAILED')) return Promise.resolve(this.status());
    this.state = 'ENTERING'; this.reason = null; this.fullSealed = false; this.fullWatermark = null; this.sealedWatermark = null;
    this.maintenanceEpoch = require('crypto').randomUUID();
    try { this.save(); } catch (e) { this.state = 'FAILED'; this.reason = 'MAINTENANCE_FLAG_WRITE_FAILED'; throw e; }
    const deadline = Date.now() + timeoutMs;
    this.operation = Promise.resolve().then(async () => {
      try {
        this.hooks.prepare?.();
        for (;;) {
          const detail = this.hooks.inspect(), blockers = this.blockers(detail);
          if (!blockers.length) break;
          if (Date.now() >= deadline) throw Error('DRAIN_TIMEOUT:' + blockers.join(';'));
          await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now())));
        }
        await this.recoverProviders();
        this.flushState = 'FLUSHING';
        await this.hooks.flush();
        if (Date.now() > deadline) throw Error('DRAIN_TIMEOUT:writer flush');
        const detail = this.hooks.inspect(), c = detail.capture;
        if (this.blockers(detail).length) throw Error('WORK_REAPPEARED_DURING_FLUSH');
        if (c.captureHalted || c.pendingFailure || c.pendingRows || c.pendingBytes || detail.journalBytes || detail.walFiles ||
            c.attemptedRows !== c.acceptedRows + c.lostRows || c.acceptedRows !== c.persistedRows || c.lostRows)
          throw Error('WRITER_BOUNDARY_NOT_CLEAN');
        this.flushState = 'COMMITTED';
        this.sealedWatermark = this.watermark(c);
        this.state = 'SEALED';
        this.fullSealed = this.fullBoundaryClean(detail);
        this.fullSymbolStatsVersion = this.fullSealed ? detail.symbolStats?.version : null;
        this.fullWatermark = this.fullSealed ? this.watermark(c) : null;
        this.save();
      } catch (e) {
        this.state = 'FAILED'; this.fullSealed = false; this.sealedWatermark = null;
        this.reason = e.message; this.flushState = 'FAILED'; this.save();
      }
      return this.status();
    }).finally(() => { this.operation = null; });
    return this.operation;
  }
  fullSeal({timeoutMs=30000}={}) {
    if (this.operation) return this.operation;
    if (this.state !== 'SEALED') throw Object.assign(Error('RESEARCH_SEAL_REQUIRED'),{statusCode:409});
    if (this.fullSealed && this.status().snapshotSafe) return Promise.resolve(this.status());
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw Object.assign(Error('INVALID_DRAIN_TIMEOUT'),{statusCode:400});
    this.fullSealed = false;
    const deadline = Date.now()+timeoutMs;
    this.operation = Promise.resolve().then(async () => {
      try {
        while (true) {
          const d = this.hooks.inspect();
          if (this.state !== 'SEALED') throw Error('RESEARCH_SEAL_INVALIDATED');
          if (!d.managementBusy && !d.managementObligations.total && !this.blockers(d).length) break;
          if (Date.now() >= deadline) throw Error('FULL_SEAL_TIMEOUT:management obligations/activity:' + JSON.stringify(d.managementObligations));
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        await this.recoverProviders();
        this.flushState = 'FLUSHING';
        await this.hooks.flush();
        const d = this.hooks.inspect(), c = d.capture;
        if (Date.now()>deadline || this.state !== 'SEALED' || !this.fullBoundaryClean(d) ||
          c.captureHalted || c.pendingFailure || c.pendingRows || c.pendingBytes || d.journalBytes || d.walFiles ||
          c.attemptedRows !== c.acceptedRows || c.acceptedRows !== c.persistedRows || c.lostRows)
          throw Error('FULL_BOUNDARY_NOT_CLEAN');
        this.fullSealed=true; this.fullWatermark=this.watermark(c);
        this.fullSymbolStatsVersion=d.symbolStats?.version; this.flushState='COMMITTED'; this.save();
      } catch(e) { this.state='FAILED'; this.fullSealed=false; this.reason=e.message; this.flushState='FAILED'; this.save(); }
      return this.status();
    }).finally(()=>{this.operation=null;});
    return this.operation;
  }
  async exit() {
    if (this.operation) await this.operation;
    if (!this.fenced()) return this.status();
    this.state = 'EXITING';
    // Commit removal before allowing producers to start. Failure keeps fences active.
    try { this.hooks.save({ maintenance: false, state: 'RUNNING' }); }
    catch (e) { this.state = 'FAILED'; this.reason = 'MAINTENANCE_FLAG_WRITE_FAILED'; throw e; }
    this.state = 'RUNNING'; this.reason = null; this.fullSealed = false;
    this.sealedWatermark = null; this.flushState = 'IDLE';
    this.fullWatermark = null;
    return this.status();
  }
}

let singleton;
function current() {
  if (singleton) return singleton;
  const file = path.join(require('./store').DATA_DIR, 'maintenance-control.json');
  singleton = new Maintenance({
    load: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined,
    save: value => { fs.mkdirSync(path.dirname(file), { recursive: true }); require('./researchStore').atomic(file, value); },
    recoverProviders: async () => {
      await require('./groqShadowProducer').recoverForMaintenance();
      await require('./alibabaShadowProducer').recoverForMaintenance();
    },
    prepare: () => require('./v3Shadow').initializeManagement(),
    inspect: () => {
      const c = require('./researchRuntime').current(), capture = c.status();
      const engine = require('./engine'), v3 = require('./v3Shadow').maintenanceStatus();
      const legacy = [require('./earlyEntryShadow'),require('./researchSupplement'),require('./researchCapture')].map(m=>m.maintenanceStatus());
      const legacyObligations = legacy.reduce((n,x)=>n+x.obligations,0);
      const nativeTrades = [...engine.getTrades({limit:Infinity}), ...engine.getShadowTrades({limit:Infinity})];
      const native = nativeTrades.filter(t => ['OPEN','PENDING'].includes(t.status)).length;
      const counterfactuals = nativeTrades.filter(t => t.marciCounterfactual?.tracking === true).length;
      const unresolved = Object.values(c.state.episodes).filter(e => !e.controlResolved ||
        Object.values(e.controls || {}).some(v => !v) || Object.values(e.arms || {}).some(v => !v)).length;
      const providers = { groq: require('./groqShadowProducer').maintenanceStatus(), qwen: require('./alibabaShadowProducer').maintenanceStatus() };
      for (const [key,provider] of [['groq','Groq'],['qwen','Alibaba']])
        providers[key].openRequests = Object.values(c.state.aiAttempts || {}).filter(a => a.provider === provider &&
          !['PARSED_RESPONSE','TRANSPORT_ERROR','INTERRUPTED_UNCERTAIN'].includes(a.aiEvent)).length;
      const runtime = require('./researchRuntime').maintenanceStatus();
      return { processBootId: require('./runtimeIdentity').processBootId, maintenanceEpoch: current().maintenanceEpoch || null,
        capture, sequence: capture.sequence, attempted: capture.attemptedRows, accepted: capture.acceptedRows,
        persisted: capture.persistedRows, lost: capture.lostRows, pendingRows: capture.pendingRows, pendingBytes: capture.pendingBytes,
        captureHalted: capture.captureHalted, pendingFailure: capture.pendingFailure, providers,
        archiveIdle: !runtime.busy && !c.exportReaders && ![...current().active.keys()].some(k=>k.startsWith('archive:')),
        exportReaders: (c.exportReaders || 0)+(current().active.get('archive:http-reader') || 0), archiveBuildActivity: current().active.get('archive:canonical') || 0,
        scanResearchBusy: engine.state.scanning || v3.researchBusy || legacy.some(x=>x.busy), managementBusy: v3.busy || [...current().active.keys()].some(k => k.startsWith('management:')),
        managementObligations: { native, counterfactuals, v3: v3.obligations, canonicalUnresolved: unresolved,
          legacyObligations, total: native + counterfactuals + v3.obligations + unresolved + legacyObligations },
        symbolStats: require('./symbolStats').maintenanceStatus(),
        journalBytes: capture.indexJournalBytes, walFiles: fs.readdirSync(c.wal).length };
    },
    flush: () => {
      require('./symbolStats').maintenanceCheckpoint();
      require('./journal').flush(); require('./engine').maintenanceCheckpoint();
      require('./v3Shadow').maintenanceCheckpoint();
      const c = require('./researchRuntime').current(); c.recover(); c.flush();
    },
  });
  return singleton;
}
module.exports = { Maintenance, current, fenced: () => current().fenced(),
  run: (lane,name,fn) => current().run(lane,name,fn), beforeAppend: () => current().beforeAppend() };

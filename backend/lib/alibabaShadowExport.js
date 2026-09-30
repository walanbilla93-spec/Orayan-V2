'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const DEFAULT_RELATIVE_LEDGER = path.join('alibaba-shadow', 'decisions.jsonl');

class AlibabaShadowExportError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AlibabaShadowExportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ledgerPath({ env = process.env, dataRoot = store.DATA_DIR } = {}) {
  const root = path.resolve(dataRoot);
  const configured = env.ALIBABA_SHADOW_LEDGER || DEFAULT_RELATIVE_LEDGER;
  const candidate = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(root, configured);

  if (!isInside(root, candidate)) {
    throw new AlibabaShadowExportError(
      403,
      'ALIBABA_SHADOW_LEDGER_OUTSIDE_DATA_ROOT',
      'Alibaba shadow ledger is not within the persistent data directory.',
    );
  }
  return { root, candidate };
}

function inspect(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const { root, candidate } = ledgerPath(options);
  let stat;
  try {
    stat = fsImpl.statSync(candidate);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  if (!stat.isFile()) {
    throw new AlibabaShadowExportError(404, 'ALIBABA_SHADOW_LEDGER_NOT_FILE', 'Alibaba shadow data is not available yet.');
  }

  // Resolve existing symlinks as well as the configured text path. This prevents a file or
  // directory symlink under backend/data from turning the fixed export into arbitrary access.
  const realRoot = fsImpl.realpathSync(root);
  const realCandidate = fsImpl.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) {
    throw new AlibabaShadowExportError(
      403,
      'ALIBABA_SHADOW_LEDGER_SYMLINK_OUTSIDE_DATA_ROOT',
      'Alibaba shadow ledger is not within the persistent data directory.',
    );
  }
  return { path: realCandidate, sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
}

function metadata(options = {}) {
  const file = inspect(options);
  if (!file) return { available: false, sizeBytes: 0, lastUpdatedAt: null };
  return {
    available: true,
    sizeBytes: file.sizeBytes,
    lastUpdatedAt: new Date(file.modifiedMs).toISOString(),
  };
}

function timestampForFilename(now = Date.now()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function download(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const file = inspect(options);
  if (!file) {
    throw new AlibabaShadowExportError(404, 'ALIBABA_SHADOW_LEDGER_MISSING', 'Alibaba shadow data is not available yet.');
  }
  return {
    stream: fsImpl.createReadStream(file.path, { highWaterMark: 64 * 1024 }),
    contentType: CONTENT_TYPE,
    filename: `orayan2_alibaba_shadow_decisions_${timestampForFilename(options.now)}.jsonl`,
    headers: { 'Content-Length': String(file.sizeBytes) },
  };
}

module.exports = {
  CONTENT_TYPE,
  AlibabaShadowExportError,
  download,
  ledgerPath,
  metadata,
  _test: { inspect, isInside, timestampForFilename },
};

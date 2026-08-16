'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.resolve(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, dflt) {
  ensureDir();
  const p = filePath(name);
  if (!fs.existsSync(p)) return dflt;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return dflt;
    return JSON.parse(raw);
  } catch (e) {
    logger.error('store', `Could not read ${name}.json — using default`, { error: e.message });
    // Preserve the unreadable file instead of silently overwriting it.
    try { fs.renameSync(p, `${p}.corrupt.${Date.now()}`); } catch (_e) { /* best effort */ }
    return dflt;
  }
}

/** Write via temp file + rename so a crash mid-write can't truncate the real file. */
function write(name, value) {
  ensureDir();
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    logger.error('store', `Could not write ${name}.json`, { error: e.message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_e) { /* best effort */ }
    return false;
  }
}

module.exports = { read, write, DATA_DIR };

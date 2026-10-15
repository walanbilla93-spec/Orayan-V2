'use strict';
const fs = require('fs');

// Synchronous traversal keeps the same snapshot boundary as JSON.stringify.
// Only a bounded output buffer and the current scalar are retained in addition
// to the original state. No whole-state clone or arrays of index entries.
function writeCheckpointJson(fd, value, writeAll, chunkChars = 48 * 1024) {
  let buffer = '';
  const ancestors = new Set();
  function flush() {
    if (buffer) { writeAll(fd, Buffer.from(buffer)); buffer = ''; }
  }
  function output(text) {
    if (buffer.length + text.length > chunkChars) flush();
    if (text.length >= chunkChars) writeAll(fd, Buffer.from(text));
    else buffer += text;
  }
  function visit(value, key, arrayItem = false, prepared = false) {
    if (!prepared && value && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (value === null || typeof value !== 'object') {
      const text = JSON.stringify(value);
      if (text === undefined) { if (arrayItem) output('null'); return; }
      output(text); return;
    }
    if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(value);
    if (Array.isArray(value)) {
      output('[');
      for (let i = 0; i < value.length; i++) { if (i) output(','); visit(value[i], String(i), true); }
      output(']');
    } else {
      output('{'); let first = true;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        let child = value[key];
        if (child && typeof child.toJSON === 'function') child = child.toJSON(key);
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (!first) output(','); first = false;
        output(JSON.stringify(key)); output(':'); visit(child, key, false, true);
      }
      output('}');
    }
    ancestors.delete(value);
  }
  visit(value, ''); flush();
}
module.exports = { writeCheckpointJson };

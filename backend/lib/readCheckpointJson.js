'use strict';
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

// Restore the existing checkpoint format without keeping the complete UTF-8
// buffer and JSON string alongside the restored indexes. Temporary input is
// bounded by one 64 KiB chunk plus the largest index entry; no history is omitted.
function readCheckpointJson(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  // Event metadata repeats epoch IDs, definition hashes and context labels.
  // Share equal string values, with a fixed cache rather than another history index.
  const strings = new Map();
  function share(value) {
    if (typeof value === 'string' && value.length <= 128) {
      const previous = strings.get(value);
      if (previous !== undefined) { strings.delete(value); strings.set(previous, previous); return previous; }
      strings.set(value, value);
      if (strings.size > 4096) strings.delete(strings.keys().next().value);
    } else if (value && typeof value === 'object') {
      for (const key in value) if (Object.hasOwn(value, key)) value[key] = share(value[key]);
    }
    return value;
  }
  let text = '', offset = 0, ended = false;
  function peek() {
    while (offset === text.length && !ended) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      text = count ? decoder.write(buffer.subarray(0, count)) : decoder.end();
      offset = 0;
      if (!count) ended = true;
    }
    return text[offset];
  }
  const invalid = () => { throw new SyntaxError('Invalid research checkpoint JSON'); };
  function whitespace() {
    while ([' ', '\t', '\r', '\n'].includes(peek())) offset++;
  }
  function consume(char) {
    if (peek() !== char) invalid();
    offset++;
  }
  function string() {
    consume('"');
    const parts = ['"'];
    let escaped = false;
    for (;;) {
      const char = peek();
      if (char === undefined) invalid();
      const start = offset;
      // Accumulate slices rather than a per-character rope for large scalars.
      while (offset < text.length) {
        const c = text[offset++];
        if (!escaped && c === '"') {
          parts.push(text.slice(start, offset));
          return JSON.parse(parts.join(''));
        }
        if (!escaped && c === '\\') escaped = true;
        else escaped = false;
      }
      parts.push(text.slice(start, offset));
    }
  }
  function entry() {
    whitespace();
    const char = peek();
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const parts = [];
      let depth = 0, quoted = false, escaped = false;
      for (;;) {
        if (peek() === undefined) invalid();
        const start = offset;
        while (offset < text.length) {
          const c = text[offset++];
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') depth--;
          if (!quoted && depth === 0) {
            parts.push(text.slice(start, offset));
            return share(JSON.parse(parts.join('')));
          }
        }
        parts.push(text.slice(start, offset));
      }
    }
    let token = '';
    while (peek() !== undefined && ![' ', '\t', '\r', '\n', ',', ']', '}'].includes(peek())) {
      token += peek(); offset++;
    }
    if (!token || !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) invalid();
    return JSON.parse(token);
  }
  function value(depth = 0) {
    whitespace();
    const char = peek();
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const array = char === '[', result = array ? [] : {};
      offset++;
      whitespace();
      const end = array ? ']' : '}';
      if (peek() === end) { offset++; return result; }
      for (;;) {
        whitespace();
        let key;
        if (!array) { if (peek() !== '"') invalid(); key = string(); whitespace(); consume(':'); }
        // Let V8 restore each record with its compact native object layout.
        // Building every nested field in JS significantly inflates live state.
        const child = depth < 1 ? value(depth + 1) : entry();
        if (array) result.push(child);
        else Object.defineProperty(result, key, { value: child, writable: true, enumerable: true, configurable: true });
        whitespace();
        if (peek() === end) { offset++; return result; }
        consume(',');
      }
    }
    return entry();
  }
  try {
    const result = value();
    whitespace();
    if (peek() !== undefined) invalid();
    return result;
  } finally { fs.closeSync(fd); }
}
module.exports = { readCheckpointJson };

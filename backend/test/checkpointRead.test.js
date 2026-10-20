'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { readCheckpointJson } = require('../lib/readCheckpointJson');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'status.json');
}
test('incremental checkpoint reader matches JSON.parse across chunk boundaries and JSON types', t => {
  const file = fixture(t);
  const values = [null, true, -0, 1.25e30, '日本🌈\ud800', [], {},
    JSON.parse('{"__proto__":{"safe":true},"constructor":1,"events":{"a":{"__proto__":4}}}'),
    { events: { a: { text: 'x'.repeat(65500) + '\\"日本🌈'.repeat(200), nested: [false, null, {}, [1]] } }, archives: [{ eventIds: Array.from({length:5000}, (_, i) => 'event-' + i) }] }];
  for (const value of values) {
    for (const padding of [0, 1, 65534, 65535, 65536]) {
      const raw = ' '.repeat(padding) + JSON.stringify(value) + '\r\n';
      fs.writeFileSync(file, raw);
      assert.deepStrictEqual(readCheckpointJson(file), JSON.parse(raw));
    }
  }
  assert.equal({}.safe, undefined);
});
test('invalid or torn checkpoints fail without changing evidence', t => {
  const file = fixture(t);
  for (const raw of ['', '{', '{"a":', '{"a":1,}', '[1,]', '{"a":true false}', '{"a":[}',
    '{"events":{"a":{"x":1}}', '{"a":"bad\nstring"}', '{"a":01}', '{"a":NaN}', '{} trailing',
    '{"a":{"b":"\\q"}}', '{"a":["unterminated]', '{"events":{"a":{"x":1,}}}']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => readCheckpointJson(file), SyntaxError, raw);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});
test('duplicate keys and prototype-like names retain native JSON semantics', t => {
  const file = fixture(t), raw = '{"events":{"__proto__":{"x":1},"a":1,"a":2},"events":{"__proto__":{"y":2}},"x":-0}';
  fs.writeFileSync(file, raw);
  assert.deepStrictEqual(readCheckpointJson(file), JSON.parse(raw));
});
test('checkpoint restore never performs a whole-file read', t => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({events:Object.fromEntries(Array.from({length:2000},(_,i)=>[i,{epoch:'same-epoch',data:'x'.repeat(500)}]))}));
  const read = fs.readFileSync;
  fs.readFileSync = () => { throw Error('whole-file read'); };
  try { assert.equal(Object.keys(readCheckpointJson(file).events).length, 2000); }
  finally { fs.readFileSync = read; }
});

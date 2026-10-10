"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { sample } = require("../lib/researchExcursions");
test("BUY and SELL excursion bounds use immutable initial risk and explicitly label timing uncertainty", () => {
  const buy = { filledAt: 1000, fillPrice: 100, sl: 98, side: "BUY" },
    short = { filledAt: 1000, fillPrice: 100, sl: 102, side: "SELL" };
  const b = sample(buy, { ts: 1000, high: 104, low: 99 });
  assert.equal(b.mfeR, 2);
  assert.equal(b.maeR, -0.5);
  assert.equal(b.includesPossiblePreFillExtremes, true);
  const s = sample(short, { ts: 2000, high: 101, low: 96 });
  assert.equal(s.mfeR, 2);
  assert.equal(s.maeR, -0.5);
  const next = sample({ ...buy, sl: 99 }, { ts: 2000, high: 101, low: 97 }, b);
  assert.equal(next.initialStop, 98);
  assert.equal(next.mfeR, 2);
  assert.equal(next.maeR, -1.5);
  assert.equal(next.intrabarOrder, "UNKNOWN");
  assert.equal(next.terminalMinuteMayIncludePostExitExtremes, true);
  assert.equal(sample(buy, { ts: 999, high: 150, low: 50 }), null);
  assert.deepEqual(buy, {
    filledAt: 1000,
    fillPrice: 100,
    sl: 98,
    side: "BUY",
  });
});

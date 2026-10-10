#!/usr/bin/env node
"use strict";
// Qualification workload, never a claim about live production traffic.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { ResearchStore } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive"),
  ai = require("../lib/researchAI"),
  minimal = require("../lib/minimalCapture");
async function profile(target, { evaluations = 500, decisions = 2000 } = {}) {
  if (fs.existsSync(target)) throw Error("PROFILE_TARGET_ALREADY_EXISTS");
  const at = Date.parse("2026-09-01T01:00:00Z"),
    store = new ResearchStore(target, { reserveBytes: 0, now: () => at }),
    latencies = [];
  const old = {
    researchEnabled: minimal.researchEnabled,
    current: minimal.current,
  };
  minimal.researchEnabled = () => true;
  minimal.current = () => store;
  const start = Date.now();
  try {
    store.emit("definitions", {
      definitionId: "CONFIG",
      definition: { mode: "QUALIFICATION_FIXTURE" },
    });
    for (let i = 0; i < decisions; i++) {
      const t = performance.now();
      store.emit("decisions", {
        sourceEpisodeId: "E" + i,
        at,
        boundary: "BIRTH",
        symbol: "TEST" + (i % 60) + "USDT",
        side: i % 2 ? "BUY" : "SELL",
        score: i % 100,
        configHash: "CONFIG",
        context: {
          regime: "BULL_RANGE",
          phase: "ENTRY",
          breadth: (i % 100) / 100,
        },
        admission: i < evaluations ? "ELIGIBLE" : "REJECTED",
      });
      latencies.push(performance.now() - t);
      if (i >= evaluations)
        store.emit("lifecycle", {
          sourceEpisodeId: "E" + i,
          at,
          transitions: ["NO_ORDER"],
          reasonCode: "REJECTED_GATE",
        });
    }
    for (let i = 0; i < evaluations; i++) {
      const provider = i % 2 ? "groq" : "alibaba",
        advisor = require("../../research/" + provider + "-shadow/src/advisor"),
        candidate = require("../test/fixtures/" + provider + "Candidate")();
      candidate.candidate_id = "C" + i;
      candidate.candidate_episode_id = "E" + i;
      const config = {
        ...advisor.configFromEnv({}),
        ledger: path.join(target, provider + "-unused-ledger.jsonl"),
        allowedRoot: target,
        apiKey: "qualification-fixture",
        allowLive: true,
        maxRequestsDay: 10000,
        maxTokensDay: 100000000,
        maxRequestsMinute: 10000,
        maxTokensMinute: 100000000,
        maxCostUsdDay: 1000,
      };
      const result = await advisor.advise(candidate, {
        config,
        mode: "mock",
        nowMs: Date.parse("2026-09-28T10:00:05Z"),
        completedMs: Date.parse("2026-09-28T10:00:06Z"),
        mockTransport: async () => ({
          ok: true,
          status: "OK",
          httpStatus: 200,
          headers: { request_id: "CALL" + i },
          body: {
            id: "CALL" + i,
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 120,
              total_tokens: 2120,
            },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decision: "RETAIN",
                    risk_level: "LOW",
                    confidence: 0.7,
                    reason_codes: ["EVIDENCE_COMPLETE"],
                    reason_notes: [],
                    evidence_keys: ["h1.state"],
                    missing_or_stale: [],
                    rationale_short: "Causal qualification fixture " + i,
                  }),
                },
              },
            ],
          },
        }),
      });
      if (result.status !== "OK")
        throw Error("QUALIFICATION_DISPATCH_NOT_OK:" + result.status);
      for (const transition of [
        "ORDER_INTENT",
        "FILLED",
        "MANAGEMENT_MILESTONE",
      ])
        store.emit("lifecycle", {
          sourceEpisodeId: "E" + i,
          at,
          transitions: [transition],
          tradeId: "T" + i,
          entry: 100,
          stop: 98,
          tp: 104,
          maeR: -0.3,
          mfeR: 1.8,
        });
      const simulatedTrade = {
        id: "T" + i,
        episodeId: "E" + i,
        filledAt: at,
        fillPrice: 100,
        sl: 98,
        side: "BUY",
        symbol: "TEST" + (i % 60) + "USDT",
      };
      for (let j = 0; j < 5; j++)
        if(!require("../lib/researchExcursions").observeMinute(simulatedTrade, {
          ts: at + j * 60000,
          high: 101 + j * 0.5,
          low: 99 - j * 0.25,
        }))throw Error('QUALIFICATION_EXCURSION_NOT_CAPTURED');
      if (i < 100) {
        store.emit("experiments", {
          sourceEpisodeId: "E" + i,
          controlTradeId: "T" + i,
          tradeId: "T" + i,
          policy: "ATR1M_1P5_REPLACEMENT",
          status: "PENDING",
          complete: false,
          configHash: "CONFIG",
        });
        for (let j = 0; j < 60; j += 30)
          if(!minimal.observe("paths", {
            outputType: "V34B_ARM_MINUTE_PATH",
            capturedAt: at,
            tradeId: "T" + i,
            episodeId: "E" + i,
            eventId: "P" + i + ":" + j,
            researchOnly: true,
            executionAllowed: false,
            bars: Array.from({ length: 30 }, (_, b) => ({
              ts: at + (j + b) * 60000,
              open: 100 + (j + b) / 100,
              high: 101 + (j + b) / 100,
              low: 99 - (j + b) / 100,
              close: 100 + (j + b) / 100,
              receivedAt: at + 3600000,
            })),
          }))throw Error('QUALIFICATION_EXPERIMENT_PATH_NOT_CAPTURED');
        store.emit("experiments", {
          sourceEpisodeId: "E" + i,
          controlTradeId: "T" + i,
          tradeId: "T" + i,
          policy: "ATR1M_1P5_REPLACEMENT",
          status: "CLOSED",
          complete: true,
          configHash: "CONFIG",
          endpoint: { outcomeComplete: true, netPnl: 1.1 },
        });
      }
      store.emit("outcomes", {
        tradeId:'T'+i,
        sourceEpisodeId: "E" + i,
        at,
        status: "CLOSED",
        outcomeComplete: true,
        realizedR: 1.2,
        maeR: -0.3,
        mfeR: 1.8,
        excursionPrecision: "QUALIFICATION_FIXTURE",
      });
    }
    const before = store.status(),
      stateBytes = fs.statSync(store.file).size,
      physicalBytes = store.state.segments.reduce((n, s) => n + s.bytes, 0),
      closed = await archive.closeDay(store, "2026-09-01");
    latencies.sort((a, b) => a - b);
    return {
      measurement: "SYNTHETIC_24_HOUR_QUALIFICATION; NOT_LIVE_OBSERVED",
      schemaVersion: before.schemaVersion,
      workload: {
        actualMockEvaluations: evaluations,
        uniqueDecisions: decisions,
        providerSplit: "50/50",
        minuteExperimentReplay: "100 active treatments; 60 minutes each",
        nativeExtrema: "500 trades; 5 observed OHLC boundaries each",
      },
      logicalBytes: before.acceptedBytes,
      logicalMBPerDay: before.acceptedBytes / 1e6,
      physicalSegmentBytes: physicalBytes,
      physicalMBPerDay: physicalBytes / 1e6,
      statusBytes: stateBytes,
      zipBytes: closed.bytes,
      zipMBPerDay: closed.bytes / 1e6,
      streams: Object.entries(before.bytesByStream)
        .map(([stream, bytes]) => ({
          stream,
          records: before.countsByStream[stream],
          bytes,
          MBPerDay: bytes / 1e6,
        }))
        .sort((a, b) => b.bytes - a.bytes),
      top5: Object.entries(before.bytesByStream)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      criticalLoss: before.lostRows,
      reconciliation: store.status().reconciliation,
      decisionCommitLatencyMs: {
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.floor(latencies.length * 0.95)],
        max: latencies.at(-1),
      },
      checkpointEvery: store.checkpointEvery,
      elapsedMs: Date.now() - start,
      archiveSha256: closed.sha256,
      limits: before.limits,
    };
  } finally {
    Object.assign(minimal, old);
  }
}
if (require.main === module) {
  const [target, output] = process.argv.slice(2);
  if (!target || !output)
    throw Error("Usage: research-profile.js NEW_SCRATCH_DIRECTORY REPORT.json");
  profile(path.resolve(target))
    .then((r) => fs.writeFileSync(output, JSON.stringify(r, null, 2)))
    .catch((e) => {
      process.stderr.write((e.code || e.message) + "\n");
      process.exitCode = 1;
    });
}
module.exports = { profile };

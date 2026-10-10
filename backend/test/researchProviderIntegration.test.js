"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { ResearchStore } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive"),
  minimal = require("../lib/minimalCapture");
for (const provider of ["groq", "alibaba"])
  test(
    provider +
      " actual advisor writes canonical request/raw/parsed and budget ledger, without legacy files",
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-provider-")),
        c = new ResearchStore(dir, { reserveBytes: 0 }),
        old = {
          researchEnabled: minimal.researchEnabled,
          current: minimal.current,
        };
      minimal.researchEnabled = () => true;
      minimal.current = () => c;
      t.after(() => {
        Object.assign(minimal, old);
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const advisor = require(
          "../../research/" + provider + "-shadow/src/advisor",
        ),
        ledger = require("../../research/" + provider + "-shadow/src/ledger");
      ledger._test.resetCaches();
      const snapshot = require("./fixtures/" + provider + "Candidate")();
      snapshot.candidate_episode_id = "EP";
      c.emit("decisions", { sourceEpisodeId: "EP", boundary: "BIRTH" });
      const config = {
        ...advisor.configFromEnv({}),
        ledger: path.join(dir, "never-created.jsonl"),
        allowedRoot: dir,
        apiKey: "fake-key",
        allowLive: true,
      };
      let calls = 0;
      const result = await advisor.advise(snapshot, {
        config,
        mode: "mock",
        nowMs: Date.parse("2026-09-28T10:00:05Z"),
        completedMs: Date.parse("2026-09-28T10:00:06Z"),
        mockTransport: async () => {
          calls++;
          const before = [];
          await archive.rows(c, (r) => before.push(r));
          assert.equal(before.at(-1).event, "REQUEST_PREPARED");
          return {
            ok: true,
            status: "OK",
            httpStatus: 200,
            headers: { request_id: "CALL" },
            body: {
              usage: {
                prompt_tokens: 300,
                completion_tokens: 40,
                total_tokens: 340,
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
                      rationale_short:
                        "Causal fixture supports research retain.",
                    }),
                  },
                },
              ],
            },
          };
        },
      });
      assert.equal(result.status, "OK");
      assert.equal(fs.existsSync(config.ledger), false);
      const rows = [];
      await archive.rows(c, (r) => rows.push(r));
      const auditRow=rows.find(r=>r.kind==='AI_FULL_CAUSAL_AUDIT');
      const restoredAudit={...auditRow.definition.snapshot};
      for(const [key,id] of Object.entries(auditRow.definition.contextReferences))restoredAudit[key]=rows.find(r=>r.definitionId===id).definition.value;
      assert.deepEqual(restoredAudit,snapshot);
      assert.equal(auditRow.definition.payloadVersion,'ORAYAN_LEAN_AI_V1');
      const prepared = rows.find((r) => r.event === "REQUEST_PREPARED"),
        definitions = new Map(
          rows
            .filter((r) => r.stream === "definitions")
            .map((r) => [r.definitionId, r]),
        );
      assert.deepEqual(
        require("../lib/researchRequest").reconstruct(prepared, definitions),
        advisor.buildRequest(
          require(
            "../../research/" + provider + "-shadow/src/snapshot",
          ).compactSnapshot(snapshot).snapshot,
          config,
        ),
      );
      assert.equal(rows.filter((r) => r.event === "PROVIDER_LEDGER").length, 2);
      assert.equal(
        rows.find((r) => r.event === "PARSED_RESPONSE").parsed.decision,
        "RETAIN",
      );
      assert.equal(
        rows.find((r) => r.event === "PARSED_RESPONSE").normalizedResponse
          .decision,
        "RETAIN",
      );
      assert.equal(
        rows.find((r) => r.event === "RAW_RESPONSE").providerCallId,
        "CALL",
      );
      assert.ok(!JSON.stringify(rows).includes("fake-key"));
      ledger._test.resetCaches();
      const duplicate = await advisor.advise(snapshot, {
        config,
        mode: "mock",
        nowMs: Date.parse("2026-09-28T10:00:07Z"),
        mockTransport: () => {
          calls++;
          throw Error("must not dispatch");
        },
      });
      assert.equal(duplicate.status, "DUPLICATE_IGNORED");
      assert.equal(calls, 1);
    },
  );

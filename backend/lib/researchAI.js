"use strict";
const { sha, clean } = require("./researchStore");
function capture() {
  const m = require("./minimalCapture");
  return m.researchEnabled() ? m.current() : null;
}
function persist(c, record, options = {}) {
  if (!c.emit("ai_calls", record, options))
    throw Object.assign(Error("RESEARCH_CAPTURE_HALTED"), {
      code: "RESEARCH_CAPTURE_HALTED",
    });
}
function context(provider, snapshot, requestId, model) {
  const evaluationId = sha(
    JSON.stringify([
      provider,
      snapshot.candidate_episode_id || snapshot.episode_id || null,
      requestId,
    ]),
  );
  return {
    provider,
    model,
    evaluationId,
    sourceEpisodeId:
      snapshot.candidate_episode_id ||
      snapshot.episode_id ||
      snapshot.candidate_id,
  };
}
function begin(provider, snapshot, request, requestId, secrets = []) {
  const c = capture();
  if (!c) return null;
  if (!c.canDispatch()) throw Error("RESEARCH_CAPTURE_HALTED");
  const ctx = context(provider, snapshot, requestId, request.model),
    attemptId = require("crypto").randomUUID();
  const prior = Object.values(c.state.aiAttempts || {}).filter(
    (a) => a.evaluationId === ctx.evaluationId,
  );
  ctx.attemptNumber = prior.length + 1;
  ctx.retryOfAttemptId = prior.at(-1)?.attemptId || null;
  const sanitized = clean(request, [...c.secrets, ...secrets]);
  const packed = require("./researchRequest").pack(sanitized);
  const shared = packed.shared,
    definitionId = sha(JSON.stringify(shared));
  if (!c.state.dedupe["ai-definition:" + definitionId]) {
    if (
      !c.emit(
        "definitions",
        { definitionId, kind: "AI_SHARED_REQUEST", definition: shared },
        { key: "ai-definition:" + definitionId, signature: definitionId },
      )
    )
      throw Error("RESEARCH_CAPTURE_HALTED");
  }
  for (const fragment of packed.fragments)
    if (!c.state.dedupe["ai-context:" + fragment.definitionId]) {
      if (
        !c.emit(
          "definitions",
          {
            definitionId: fragment.definitionId,
            kind: fragment.kind,
            definition: { value: fragment.value },
          },
          {
            key: "ai-context:" + fragment.definitionId,
            signature: fragment.definitionId,
          },
        )
      )
        throw Error("RESEARCH_CAPTURE_HALTED");
    }
  const auditPack=require('./researchRequest').pack({messages:[{role:'user',content:require('./researchRequest').canonical({candidate:clean(snapshot,[...c.secrets,...secrets])})}]});
  for(const fragment of auditPack.fragments)if(!c.state.dedupe['ai-context:'+fragment.definitionId]&&!c.emit('definitions',{definitionId:fragment.definitionId,kind:fragment.kind,definition:{value:fragment.value}},{key:'ai-context:'+fragment.definitionId,signature:fragment.definitionId}))throw Error('RESEARCH_CAPTURE_HALTED');
  const audit = {kind:'AI_FULL_CAUSAL_AUDIT',payloadVersion:require('./researchPayload').VERSION,snapshot:auditPack.unique.messages[0].candidate,contextReferences:auditPack.unique.messages[0].contextReferences,parserVersion:'ORAYAN_AI_PARSE_V2',normalizationVersion:'PROVIDER_NORMALIZE_V1'};
  const auditId=sha(JSON.stringify(audit));
  if(!c.state.dedupe['ai-audit:'+auditId]&&!c.emit('definitions',{definitionId:auditId,kind:audit.kind,definition:audit,dependencyIds:auditPack.references},{key:'ai-audit:'+auditId,signature:auditId}))throw Error('RESEARCH_CAPTURE_HALTED');
  const unique = packed.unique;
  persist(c, {
    ...ctx,
    event: "REQUEST_PREPARED",
    attemptId,
    request: unique,
    exactRequestSha256: sha(JSON.stringify(request)),
    messageLayout: packed.messageLayout,
    fieldOrder: packed.fieldOrder,
    redactionsApplied: JSON.stringify(sanitized) !== JSON.stringify(request),
    sharedRequestDefinition: definitionId,
    auditDefinitionId: auditId,
    payloadVersion: require("./researchPayload").VERSION,
    dependencyIds: [definitionId, auditId, ...packed.references],
    disposition: "PENDING",
    at: Date.now(),
  });
  return { ...ctx, attemptId, definitionId, secrets };
}
function raw(ctx, text, metadata = {}) {
  if (!ctx) return;
  const c = capture();
  const { secrets, ...identity } = ctx;
  persist(c, {
    ...identity,
    event: "RAW_RESPONSE",
    rawResponse: clean(text, secrets),
    unredactedSha256: sha(text),
    redactionsApplied: clean(text, secrets) !== text,
    ...metadata,
    dependencyIds: [ctx.definitionId],
    at: Date.now(),
  });
}
function finish(ctx, result) {
  if (!ctx) return;
  const { secrets, ...identity } = ctx;
  persist(capture(), {
    ...identity,
    event: "PARSED_RESPONSE",
    parsed: Object.prototype.hasOwnProperty.call(result, "parsed_response")
      ? (result.parsed_response ?? null)
      : result.decision,
    normalizedResponse: result.decision,
    normalization: result.normalization,
    parserVersion: "ORAYAN_AI_PARSE_V2",
    normalizationVersion: "PROVIDER_NORMALIZE_V1",
    providerCallId: result.rate_limit_headers?.request_id || null,
    latencyMs: result.latency_ms,
    tokens: result.tokens,
    status: result.status,
    disposition:
      result.status === "OK"
        ? "SHADOW_ONLY"
        : /MALFORMED|INVALID/.test(result.status)
          ? "INVALID"
          : "ERROR",
    tradeDisposition: "NO_EXECUTION_AUTHORITY",
    finalEndpoint: "EPISODE_ENDPOINT_REFERENCE",
    at: Date.now(),
  });
}
function transportError(ctx, error) {
  if (!ctx) return;
  const { secrets, ...identity } = ctx;
  persist(capture(), {
    ...identity,
    event: "TRANSPORT_ERROR",
    errorCode: error.code || error.name || "ERROR",
    disposition: "ERROR",
    completionUncertain: true,
    at: Date.now(),
  });
}
function canonical(provider) {
  const c = capture();
  if (!c) return null;
  return {
    async read(visit) {
      await require("./researchArchive").rows(c, (row) => {
        if (
          row.stream === "ai_calls" &&
          row.provider === provider &&
          row.ledgerRecord
        )
          return visit(row.ledgerRecord);
      });
    },
    async append(record) {
      const evaluation = context(
        provider,
        { candidate_episode_id: record.candidate_episode_id },
        record.request_id,
        record.model,
      ).evaluationId;
      const completion = Object.values(c.state.aiAttempts || {}).find(
        (a) => a.evaluationId === evaluation && a.aiEvent === "PARSED_RESPONSE",
      );
      let compact = record;
      if (completion && record.record_type === "SHADOW_DECISION") {
        const { decision, normalization, ...budget } = record;
        compact = {
          ...budget,
          normalization: normalization
            ? { applied: normalization.applied }
            : null,
        };
      }
      persist(c, {
        provider,
        event: "PROVIDER_LEDGER",
        ledgerRecord: compact,
        decisionReference: completion?.eventId || null,
        dependencyIds: completion ? [completion.eventId] : [],
        disposition:
          record.record_type === "REQUEST_STARTED"
            ? "PENDING"
            : record.status === "OK"
              ? "SHADOW_ONLY"
              : /MALFORMED|INVALID/.test(record.status)
                ? "INVALID"
                : /API_|NETWORK|TIMEOUT|INTERRUPTED/.test(record.status)
                  ? "ERROR"
                  : "NOT_REQUESTED",
        sourceEpisodeId: record.candidate_episode_id || record.candidate_id,
        at:
          Date.parse(record.completed_at_utc || record.requested_at_utc) ||
          Date.now(),
      });
    },
  };
}
function notRequested(provider, birth, candidateId, reason) {
  const c = capture();
  if (!c || c.state.captureHalted) return false;
  return c.emit(
    "ai_calls",
    {
      provider,
      sourceEpisodeId: birth?.episodeId,
      candidateId,
      event: "DISPATCH_DISPOSITION",
      disposition: "NOT_REQUESTED",
      reason,
      at: Date.now(),
    },
    {
      key:
        "not-requested:" +
        provider +
        ":" +
        birth?.episodeId +
        ":" +
        candidateId +
        ":" +
        reason,
      signature: reason,
    },
  );
}
module.exports = {
  begin,
  raw,
  finish,
  transportError,
  canonical,
  notRequested,
};

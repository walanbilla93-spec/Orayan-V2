"use strict";
const { sha } = require("./researchStore");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sort(value[k])]),
    );
  return value;
}
const CONTEXT = [
  "regime",
  "regime_transitions",
  "h1",
  "h2",
  "exposure",
  "market_context",
  "market_intelligence",
  "gemini_briefing",
];
function pack(request) {
  const templates = {},
    fragments = [],
    references = [];
  const messages = (request.messages || [])
    .map((message, index) => {
      if (message.role === "system") return null;
      let content;
      try {
        content = JSON.parse(message.content);
      } catch {
        return { ...message };
      }
      if (!content?.candidate || canonical(content) !== message.content)
        return { ...message };
      const { candidate, ...template } = content;
      templates[index] = template;
      const unique = { ...candidate },
        contextReferences = {};
      for (const key of CONTEXT)
        if (candidate[key] !== undefined) {
          const definition = {
              kind: "AI_CONTEXT_FRAGMENT",
              value: candidate[key],
            },
            id = sha(canonical(definition));
          fragments.push({ definitionId: id, ...definition });
          references.push(id);
          contextReferences[key] = id;
          delete unique[key];
        }
      const { content: unused, ...fields } = message;
      return {
        ...fields,
        candidate: unique,
        contextReferences,
        templateMessageIndex: index,
      };
    })
    .filter(Boolean);
  const { messages: unused, response_format, ...fields } = request;
  return {
    shared: {
      system: request.messages?.filter((m) => m.role === "system"),
      response_format,
      messageTemplates: templates,
    },
    unique: { ...fields, messages },
    fieldOrder: Object.keys(request),
    messageLayout: request.messages?.map((m) =>
      m.role === "system" ? "SHARED_SYSTEM" : "UNIQUE",
    ),
    fragments,
    references: [...new Set(references)],
  };
}
function reconstruct(record, definitions) {
  const get = (id) => {
    const row =
      definitions instanceof Map ? definitions.get(id) : definitions[id];
    if (!row) throw Error("AI_REQUEST_DEPENDENCY_MISSING:" + id);
    return row.definition || row;
  };
  const shared = get(record.sharedRequestDefinition),
    unique = record.request;
  let system = 0,
    user = 0;
  const messages = (record.messageLayout || []).map((kind) => {
    if (kind === "SHARED_SYSTEM") return shared.system[system++];
    const message = unique.messages[user++];
    if (message.templateMessageIndex === undefined) return message;
    const { candidate, contextReferences, templateMessageIndex, ...fields } =
      message;
    const restored = { ...candidate };
    for (const [key, id] of Object.entries(contextReferences || {}))
      restored[key] = get(id).value;
    return {
      ...fields,
      content: canonical({
        ...shared.messageTemplates[templateMessageIndex],
        candidate: restored,
      }),
    };
  });
  const full = { ...unique, messages };
  if (shared.response_format !== undefined)
    full.response_format = shared.response_format;
  const ordered = Object.fromEntries(
    record.fieldOrder.map((key) => [key, full[key]]),
  );
  if (sha(JSON.stringify(ordered)) !== record.exactRequestSha256)
    throw Error("AI_REQUEST_RECONSTRUCTION_CHECKSUM_FAILED");
  return ordered;
}
module.exports = { pack, reconstruct, canonical };

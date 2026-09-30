'use strict';

// Sanitization is local to Alibaba: no changes to other providers' logging or contracts.
const SENSITIVE_KEY = /api.?key|secret|password|authorization|credential|export.?token/i;
function secretValues(env = process.env, extra = []) {
  return [...new Set([...extra, ...Object.entries(env)
    .filter(([key]) => SENSITIVE_KEY.test(key)).map(([, value]) => value)])]
    .filter(value => typeof value === 'string' && value.length >= 4);
}
function redact(value, extra = []) {
  const secrets = secretValues(process.env, extra);
  function clean(item) {
    if (typeof item === 'string') {
      for (const secret of secrets) item = item.split(secret).join('[REDACTED_SECRET]');
      return item.replace(/bearer\s+\S+/gi, '[REDACTED_AUTH]')
        .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED_KEY]');
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED_SECRET]' : clean(child)]));
    return item;
  }
  return clean(value);
}
module.exports = { redact };

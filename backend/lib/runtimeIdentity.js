'use strict';

const crypto = require('crypto');

const processBootId = crypto.randomUUID();
const processStartedAt = Date.now();

function rowFields() {
  return { processBootId, processStartedAt };
}

function exportIdentity(watermarkAt = Date.now(), parts = []) {
  const payload = JSON.stringify([processBootId, watermarkAt, parts]);
  return {
    snapshotId: `rs_${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24)}`,
    watermarkAt,
    processBootId,
    processStartedAt,
  };
}

module.exports = { processBootId, processStartedAt, rowFields, exportIdentity };

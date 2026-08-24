'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitize(meta)
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'error') console.error(line.trim());
    else console.log(line.trim());
    try { fs.appendFileSync(logPath, line, 'utf8'); } catch { /* Console logging remains available. */ }
  }

  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta)
  };
}

function sanitize(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|authorization|api.?key|password/i.test(key)) clone[key] = '[REDACTED]';
    else if (item && typeof item === 'object') clone[key] = sanitize(item);
    else clone[key] = item;
  }
  return clone;
}

module.exports = { createLogger, sanitize };

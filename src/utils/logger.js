'use strict';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const fmt = (msg, meta) => {
    const ts = new Date().toISOString();
    const m = meta ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${msg}${m}`;
  };
  return {
    error: (msg, meta) => { if (threshold >= LEVELS.error) console.error(fmt(msg, meta)); },
    warn: (msg, meta) => { if (threshold >= LEVELS.warn) console.warn(fmt(msg, meta)); },
    info: (msg, meta) => { if (threshold >= LEVELS.info) console.info(fmt(msg, meta)); },
    debug: (msg, meta) => { if (threshold >= LEVELS.debug) console.log(fmt(msg, meta)); },
  };
}

module.exports = { createLogger };

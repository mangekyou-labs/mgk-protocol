'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const DEFAULT_ENV_PATH = join(
  __dirname,
  '..',
  '..',
  'mgk-frontend',
  'apps',
  'web',
  '.env.local',
);

/** Load KEY=VAL lines into process.env without overwriting existing values. */
function loadWebEnv(envPath = DEFAULT_ENV_PATH, env = process.env) {
  if (!existsSync(envPath)) return { loaded: false, path: envPath };
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] == null || env[key] === '') env[key] = value;
  }
  return { loaded: true, path: envPath };
}

module.exports = { loadWebEnv, DEFAULT_ENV_PATH };

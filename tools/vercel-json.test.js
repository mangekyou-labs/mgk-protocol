/**
 * T-VERCEL-JSON-SCHEMA
 *
 * Every tracked vercel.json must only use keys from the official schema:
 * https://openapi.vercel.sh/vercel.json
 *
 * This test enforces that `engines` and `env` are never committed in
 * vercel.json files — `engines` is not a valid property (schema uses
 * `additionalProperties: false`), and `env` is deprecated and redundant
 * with dashboard/env-var config.
 *
 * Allowlist: properties actually used in this repo that ARE in the schema.
 * Node pinning belongs in package.json engines.node, not vercel.json.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join, resolve } = require('path');

// Root of the repository (one level up from tools/)
const ROOT = resolve(__dirname, '..');

/**
 * Official schema allowlist — subset of properties from
 * https://openapi.vercel.sh/vercel.json that this repo actually uses.
 * Do NOT add `engines` or `env` here.
 */
const ALLOWED_KEYS = new Set([
  '$schema',
  'buildCommand',
  'installCommand',
  'framework',
  'regions',
  'outputDirectory',
]);

/**
 * Explicitly forbidden keys — properties that are NOT in the official
 * schema or are deprecated and must not appear in committed files.
 */
const FORBIDDEN_KEYS = new Set(['engines', 'env']);

/**
 * All tracked vercel.json paths relative to repo root.
 */
const VERCEL_JSON_PATHS = [
  'vercel.json',
  'mgk-frontend/vercel.json',
  'mgk-frontend/apps/web/vercel.json',
];

describe('vercel.json schema compliance', () => {
  for (const relPath of VERCEL_JSON_PATHS) {
    const fullPath = join(ROOT, relPath);

    it(`${relPath} must not contain forbidden keys (engines, env)`, () => {
      let raw;
      try {
        raw = readFileSync(fullPath, 'utf-8');
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }

      const config = JSON.parse(raw);
      const keys = Object.keys(config);

      for (const key of keys) {
        assert.ok(
          !FORBIDDEN_KEYS.has(key),
          `${relPath} contains forbidden key "${key}". ` +
            `Vercel schema (additionalProperties: false) does not allow "engines" in vercel.json. ` +
            `Pin Node via package.json engines.node instead. ` +
            `Remove "env" — program IDs live in mgk-frontend/apps/web/lib/config.ts DEVNET_DEFAULTS; ` +
            `dashboard already has NEXT_PUBLIC_INDEXER_URL and NEXT_PUBLIC_RPC_URL.`
        );
      }

      for (const key of keys) {
        assert.ok(
          ALLOWED_KEYS.has(key),
          `${relPath} contains unexpected key "${key}". ` +
            `Not in the official schema allowlist. ` +
            `See https://openapi.vercel.sh/vercel.json for valid properties.`
        );
      }
    });
  }
});

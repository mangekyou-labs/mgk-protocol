import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {loadDeployment, loadMonitoring} from './config.js';
it('loads repository defaults independently of the indexer working directory', () => {
  const deployment = loadDeployment();
  expect(deployment.ready).toBe(true);
  expect(deployment.startSlot).toBe(517959329);
  expect(loadMonitoring().feeFloorLamports).toBe('10000000');
});
it('refuses to index a pending manifest', () => {
  const deployed = JSON.parse(readFileSync(new URL('../../../../deployments/devnet.json', import.meta.url), 'utf8'));
  const pending = {...deployed,
    accounts: Object.fromEntries(Object.keys(deployed.accounts).map(k => [k, {status: 'pending'}])),
    start_slot: {status: 'pending'}};
  const path = join(mkdtempSync(join(tmpdir(), 'mgk-indexer-')), 'devnet.json');
  writeFileSync(path, JSON.stringify(pending));
  expect(() => loadDeployment(path)).toThrow('Deployment manifest pending');
});

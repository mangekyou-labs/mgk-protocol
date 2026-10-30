import {expect, it} from 'vitest';
import {loadDeployment, loadMonitoring} from './config.js';
it('loads repository defaults independently of the indexer working directory', () => {
  expect(() => loadDeployment()).toThrow('Deployment manifest pending');
  expect(loadMonitoring().feeFloorLamports).toBe('10000000');
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(process.cwd(), '../../../docs/ifc-pitch/deck.html'), 'utf8');

describe('IFC pitch deck claim guards', () => {
  it('contains exactly two editable 16:9 slides', () => {
    expect(html.match(/<section class="slide/g)).toHaveLength(2);
    expect(html).toContain('@page { size: 13.333in 7.5in; margin: 0; }');
  });

  it('uses the approved headline and honest product boundary', () => {
    expect(html).toContain('Fair execution infrastructure for Vietnam’s next Nasdaq-linked market.');
    expect(html).toContain('open-source Solana DFBA perps prototype');
    expect(html).toContain('devnet');
    expect(html).toContain('unaudited');
  });

  it('keeps shipped, sandbox, and roadmap capabilities distinct', () => {
    for (const label of ['SHIPPED PROTOTYPE', 'SANDBOX DEMO', 'ROADMAP']) expect(html).toContain(label);
  });

  it('contains Vietnamese summary, licensing caveat, and official sources', () => {
    expect(html).toContain('TÓM TẮT ĐIỀU HÀNH');
    expect(html).toContain('US Tech 100 Sandbox');
    expect(html).toContain('partnership and licensing milestone');
    for (const source of ['jumpcrypto.com/resources/dual-flow-batch-auction', 'nasdaq.com/products/global-indexes/licensing-and-etps', 'vanban.chinhphu.vn', 'ssc.gov.vn']) expect(html).toContain(source);
  });

  it('does not imply direct-retail authorization or Nasdaq endorsement', () => {
    for (const forbidden of ['democratize', 'Nasdaq-backed', 'Nasdaq partner', 'approved for retail', 'licensed by Nasdaq']) expect(html).not.toContain(forbidden);
  });

  it('includes the product website and source repository', () => {
    expect(html).toContain('https://mgkprotocol.vercel.app');
    expect(html).toContain('https://github.com/mangekyou-labs/mgk-solana');
  });
});

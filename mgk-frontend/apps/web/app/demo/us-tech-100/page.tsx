import type { Metadata } from 'next';

import { UsTech100Sandbox } from '@/components/demo/UsTech100Sandbox';

export const metadata: Metadata = {
  title: 'US Tech 100 Sandbox · MGK',
  description: 'A local-state partner sandbox demonstrating deterministic dual-flow batch execution. All values are simulated.',
};

export default async function UsTech100Page({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const params = await searchParams;
  return <UsTech100Sandbox previewSettled={params.preview === 'settled'} />;
}

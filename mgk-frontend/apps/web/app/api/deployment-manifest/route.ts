import { deployment } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** A stale browser build must compare its bundled market with this deployment. */
export function GET() {
  return Response.json(deployment, { headers: { 'Cache-Control': 'no-store' } });
}

/* eslint-disable @typescript-eslint/no-require-imports -- Node-only isolated build harness. */
/* Controlled UI evidence only. The deployable checkout is never modified. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const net = require('node:net');
const web = path.resolve(__dirname, '..');
const frontend = path.resolve(web, '../..');
const root = path.resolve(frontend, '..');
const { PublicKey } = require(path.join(web, 'node_modules/@solana/web3.js'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgk-controlled-ui-'));
const dest = path.join(temp, 'mgk-frontend');
const stagedWeb = path.join(dest, 'apps/web');
const prepareOnly = process.argv.includes('--prepare-only');
const output = path.join(web, 'test-results/truthfulness');
const env = { ...process.env, NO_DNA: '1', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_RPC_URL: 'https://api.devnet.solana.com', NEXT_PUBLIC_INDEXER_URL: 'http://localhost:4000', NEXT_PUBLIC_HERMES_URL: 'https://hermes.pyth.network' };
let server;
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
}
async function main() {
  if (process.env.E2E_BASE_URL) throw new Error('Local harness refuses E2E_BASE_URL. Use e2e:truthfulness for a reviewed remote candidate.');
  console.log('CONTROLLED UI FIXTURES ONLY: no transactions, accounting or deployed-build evidence.');
  run('pnpm', ['--filter', '@mgk/sdk', 'build'], frontend);
  fs.cpSync(frontend, dest, { recursive: true, filter: src => !['node_modules', '.next', 'test-results', 'playwright-report', '.git'].includes(path.basename(src)) && !path.basename(src).startsWith('.env') });
  for (const relative of ['', 'apps/web', 'apps/indexer', 'packages/sdk']) {
    const from = path.join(frontend, relative, 'node_modules');
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(dest, relative, 'node_modules'), 'dir');
  }
  fs.mkdirSync(path.join(temp, 'deployments'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deployments/devnet.json')));
  manifest.name = 'controlled-ui-fixture-NOT-A-DEPLOYMENT';
  Object.keys(manifest.accounts).forEach((key, i) => {
    manifest.accounts[key] = { status: 'deployed', address: new PublicKey(new Uint8Array(32).fill(i + 80)).toBase58() };
  });
  manifest.start_slot = { status: 'set', slot: 42 };
  fs.writeFileSync(path.join(temp, 'deployments/devnet.json'), JSON.stringify(manifest));
  // This copy mounts the real route and existing providers; production maintenance stays intact.
  fs.writeFileSync(path.join(stagedWeb, 'app/layout.tsx'), `import './globals.css';
import { SolanaProvider } from '@/components/providers/SolanaProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { Header } from '@/components/layout/Header';
import { TxToaster } from '@/components/common/TxToast';
export default function Layout({children}: {children: React.ReactNode}) {
return <html lang="en"><body><ThemeProvider><SolanaProvider><Header /><aside role="note">Browser test preview · synthetic data · not a devnet trading deployment</aside>{children}<TxToaster /></SolanaProvider></ThemeProvider></body></html>;
}`);
  if (prepareOnly) { console.log(`CONTROLLED_STAGING_ROOT=${temp}`); return; }
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  env.E2E_BASE_URL = `http://127.0.0.1:${port}`;
  run('pnpm', ['build', '--webpack'], stagedWeb);
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next', { paths: [web] }), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: stagedWeb, env, stdio: 'inherit' });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${env.E2E_BASE_URL}/api/deployment-manifest`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Controlled build did not become ready');
  run('pnpm', ['e2e:truthfulness'], stagedWeb);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  const artifacts = path.join(stagedWeb, 'test-results/truthfulness');
  if (fs.existsSync(artifacts)) {
    fs.rmSync(output, { recursive: true, force: true });
    fs.cpSync(artifacts, output, { recursive: true });
    fs.writeFileSync(path.join(output, 'SCOPE.txt'), 'Controlled local UI fixtures. Temporary layout mounts real route/providers. Synthetic manifest and RPC/wallet observations. No chain execution, accounting, deployed Vercel or release-gate proof.\n');
    console.log(`Artifacts: ${output}`);
  }
  if (!prepareOnly || process.exitCode) fs.rmSync(temp, { recursive: true, force: true });
});

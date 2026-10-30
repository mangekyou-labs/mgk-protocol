import {it,expect,vi,afterEach} from 'vitest';
import raw from '../../../../deployments/devnet.json';
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it('loads deployment identity from the manifest and disables pending signing',async()=>{vi.stubEnv('NEXT_PUBLIC_CORE_PROGRAM_ID','11111111111111111111111111111111');const {config}=await import('./config');expect(config.coreProgramId.toBase58()).toBe(raw.programs.perps_core);expect(config.deploymentReady).toBe(false);expect(config.registryAddress).toBeNull();expect(config.bookAddress).toBeNull();expect(config.vaultAddress).toBeNull();expect('batchAddress' in config).toBe(false);});
it('accepts transport URLs without changing deployment identity',async()=>{vi.stubEnv('NEXT_PUBLIC_RPC_URL','https://rpc.example.com');const {config}=await import('./config');expect(config.rpcUrl).toBe('https://rpc.example.com');});

import {it,expect,vi,afterEach} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import raw from '../../../../deployments/devnet.json';
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it('loads the deployed identity from the manifest regardless of env overrides',async()=>{vi.stubEnv('NEXT_PUBLIC_CORE_PROGRAM_ID','11111111111111111111111111111111');const {config}=await import('./config');expect(config.coreProgramId.toBase58()).toBe(raw.programs.perps_core);expect(config.deploymentReady).toBe(true);expect(config.registryAddress?.toBase58()).toBe(raw.accounts.registry.address);expect(config.vaultAddress?.toBase58()).toBe(raw.accounts.insurance.address);expect(config.bookAddress?.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('book'),Buffer.alloc(2)],new PublicKey(raw.programs.perps_matcher))[0].toBase58());expect('batchAddress' in config).toBe(false);});
it('accepts transport URLs without changing deployment identity',async()=>{vi.stubEnv('NEXT_PUBLIC_RPC_URL','https://rpc.example.com');const {config}=await import('./config');expect(config.rpcUrl).toBe('https://rpc.example.com');});

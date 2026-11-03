import {it,expect,vi,afterEach} from 'vitest';
import {deriveInstrumentPda} from '@mgk/sdk';
import {PublicKey} from '@solana/web3.js';
import raw from '../../../../deployments/devnet.json';
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it('loads the deployed identity from the manifest regardless of env overrides',async()=>{vi.stubEnv('NEXT_PUBLIC_CORE_PROGRAM_ID','11111111111111111111111111111111');const {config}=await import('./config');expect(config.coreProgramId.toBase58()).toBe(raw.programs.perps_core);expect(config.deploymentReady).toBe(true);expect(config.registryAddress?.toBase58()).toBe(raw.accounts.registry.address);expect(config.vaultAddress?.toBase58()).toBe(raw.accounts.insurance.address);expect(config.bookAddress?.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('book'),Buffer.alloc(2)],new PublicKey(raw.programs.perps_matcher))[0].toBase58());expect('batchAddress' in config).toBe(false);});
it('accepts transport URLs without changing deployment identity',async()=>{vi.stubEnv('NEXT_PUBLIC_RPC_URL','https://rpc.example.com');const {config}=await import('./config');expect(config.rpcUrl).toBe('https://rpc.example.com');});
it('selects one public scoped deployment at build time and derives its matcher book',async()=>{
 const seed=new Uint8Array(32).fill(7), core=new PublicKey(raw.programs.perps_core),matcher=new PublicKey(raw.programs.perps_matcher);
 const registry=PublicKey.findProgramAddressSync([Buffer.from('registry'),seed],core)[0];
 const vault=PublicKey.findProgramAddressSync([Buffer.from('vault'),registry.toBuffer()],core)[0];
 const manifest={...raw,schema_version:2,market_seed:new PublicKey(seed).toBase58(),accounts:{...raw.accounts,instrument:{status:'deployed',address:deriveInstrumentPda(0,core,{marketSeed:new PublicKey(seed).toBase58()})[0].toBase58()},insurance:{status:'deployed',address:vault.toBase58()},registry:{status:'deployed',address:registry.toBase58()}}};
 vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MANIFEST_JSON',JSON.stringify(manifest));
 const {config}=await import('./config');
 expect(config.marketSeed).toBe(manifest.market_seed);
 expect(config.bookAddress?.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('book'),registry.toBytes(),Buffer.alloc(2)],matcher)[0].toBase58());
});

it('rejects a namespace that does not match the configured addresses', async () => {
 vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MANIFEST_JSON', JSON.stringify({...raw,schema_version:2,market_seed:new PublicKey(new Uint8Array(32).fill(8)).toBase58()}));
 await expect(import('./config')).rejects.toThrow('namespace mismatch');
});

it('rejects a foreign instrument paired with the selected registry and vault', async () => {
 const core = new PublicKey(raw.programs.perps_core), seed = new Uint8Array(32).fill(7);
 const registry = PublicKey.findProgramAddressSync([Buffer.from('registry'),seed],core)[0];
 const vault = PublicKey.findProgramAddressSync([Buffer.from('vault'),registry.toBuffer()],core)[0];
 const manifest = {...raw,schema_version:2,market_seed:new PublicKey(seed).toBase58(),accounts:{...raw.accounts,
   registry:{status:'deployed',address:registry.toBase58()},insurance:{status:'deployed',address:vault.toBase58()}}};
 vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MANIFEST_JSON',JSON.stringify(manifest));
 await expect(import('./config')).rejects.toThrow('namespace mismatch');
});

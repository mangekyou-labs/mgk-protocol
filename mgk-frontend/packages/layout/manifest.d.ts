export interface DeploymentManifest {
 name: string;
 cluster: 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta';
 programs: {perps_core: string; perps_matcher: string; oracle: string};
 accounts: {registry: string | null; instrument: string | null; oracle: string | null; insurance: string | null; maker: string | null};
 startSlot: number | null;
 ready: boolean;
}
export function loadManifest(raw: unknown): DeploymentManifest;

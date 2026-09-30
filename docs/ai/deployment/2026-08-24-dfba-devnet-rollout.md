# T9.11 DFBA Devnet Deployment — Acceptance Evidence

**Date:** 2026-08-24
**Merge commit:** (to be filled after merge)
**Render deploy IDs:** (to be filled after deploy)
**Vercel deployment URL:** mgk-frontend.vercel.app
**Vercel preview recovery:** T9.11.8b — `vercel.json` schema fixed; `engines`/`env` removed; `$schema` added; Node pinned via `package.json` `engines.node = "22.x"`.

## Deployment Checklist

### Vercel Preview Recovery (T9.11.8b)

- [x] Root `vercel.json` — removed `engines` and deprecated `env` (official schema `additionalProperties: false` rejects both)
- [x] Root `vercel.json` — added `$schema` declaration
- [x] Root `package.json` — added `engines.node = "22.x"`
- [x] CI workflows retargeted to `master` (was `main`/`develop`)
- [x] Schema test: `tools/vercel-json.test.js` (TDD red → green → regression → green)
- [ ] Feature branch push → Git-linked Vercel preview READY
- [ ] `gh pr checks` all pass or pending-then-pass
- [ ] `mgk-solana` project PATCH: Root Directory empty, production branch `master`
- [ ] `mgk-frontend` and `percolator` dashboard Node set to 22.x

**Production promote is OUT OF SCOPE** for this recovery pass. Do not `vercel deploy --prod`. Live `mgkprotocol.vercel.app` serves the prior healthy deploy until a later promote after T9.11.12.

### Infrastructure
- [ ] `render.yaml` committed to `origin/master`
- [ ] mgk-indexer service deployed (read-only, no embedded keeper)
- [ ] mgk-keeper service deployed (auto-deploy disabled)
- [ ] mgk-oracle service deployed (auto-deploy disabled)
- [ ] Keeper keypair mounted as Render secret
- [ ] Oracle authority keypair mounted as Render secret
- [ ] Indexer SQLite disk mounted at `/var/data`

### Oracle Authority Rotation
- [ ] Generated dedicated oracle keypair (outside repository)
- [ ] Rotated PriceOracle authority to oracle-only key
- [ ] Oracle worker started; fresh on-chain update within 30 seconds
- [ ] Verified `oracle.last_update` slot within 50 slots of current

### Keeper Start
- [ ] Keeper worker started
- [ ] First batch transition (CloseCollecting → ClearBatch → SettleBatch) successful
- [ ] Transaction signatures recorded

### Frontend Deploy
- [ ] Exact merge commit promoted to Vercel production
- [ ] `mgkprotocol.vercel.app` verified
- [ ] `mgk-frontend.vercel.app` verified
- [ ] `NEXT_PUBLIC_BATCH_ADDRESS` unset (dynamic)

### Post-deploy Verification
- [ ] Local main worktree fast-forwarded to `origin/master`
- [ ] Temporary preview indexer removed
- [ ] Both checkpoint branches preserved

## Transaction Signatures

| Operation | Signature | Slot | Timestamp |
|-----------|-----------|------|-----------|
| Oracle authority rotation | | | |
| First oracle price post | | | |
| First batch transition (close) | | | |
| First batch transition (clear) | | | |
| First batch transition (settle) | | | |
| Portfolio creation (wallet) | | | |
| Deposit | | | |
| Post order (maker) | | | |
| Post order (taker) | | | |
| Fill observed | | | |

## Rollback Procedure

1. **Suspend faulty worker** (keeper or oracle) via Render dashboard → preserves single-writer invariant
2. **Revert Vercel** independently if frontend is affected
3. **Keep healthy oracle** running when rolling back indexer/frontend code
4. **If oracle rollback needed:** rotate authority explicitly; never run two publishers concurrently
5. **Indexer:** redeploy previous commit; SQLite data persists on disk

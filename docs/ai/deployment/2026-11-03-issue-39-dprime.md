# Issue #39 D′ deployment record — 2026-11-03

This is a dated devnet observation, not production approval. Issue #39 remains open and PR #72 remains draft. See the [readiness assessment](../../ops/issue-39-readiness.md) for evidence and outstanding gates.

## Programs

Read-only executable/ProgramData verification at 2026-11-03T11:59:41.297Z is retained in [deployment-verification.json](../../ops/evidence/issue-39-2026-11-03/deployment-verification.json). Hashes below cover the executable image, excluding the 45-byte upgradeable-loader metadata header.

| Program | Address | Deployment slot | Image bytes | Image SHA-256 |
| --- | --- | --- | --- | --- |
| perps_core | `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | 518135007 | 261824 | `efa553577be98d385174a4bad64768f6e56a99cb53748c97ef2b9b6403dc588d` |
| perps_matcher | `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK` | 518171780 | 83360 | `f3e1829749fbb467504dce8a59b53e5a266f15c5d66e3050097b43d1a485553b` |
| oracle | `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm` | 517922158 | 13808 | `022f61b9e4c456eaac5f90efd93e5bc54d817f75e11f37cb8fde7f2e2b93486a` |

The matcher ProgramData allocation contains 87,184 payload bytes: the 83,360-byte image plus 3,824 verified zero padding bytes. The entire allocated payload hashes to `48e4dcea45d144259b99fe2b3c336515e5bf9c874fc0e96d307c949361589f19`. This differs from the image hash because of padding. The matcher upgrade transaction is `3zN9UMpLdc1uR6oBCrqvKEG2Gd22YyXXaAzAbrSAXZsCeJs3CidWv1SgAq7Kty3oDHZ97fz4kRPUWvmstSxeMnEq`. Evidence before its slot does not qualify the upgraded executable.

## Market and hosted source pins

[devnet-dprime.json](../../../deployments/devnet-dprime.json) is the shared schema-2 manifest, start slot 518144057. D′ separates market accounts while sharing program IDs with the default market. Initial insurance and maker collateral were 3 SOL each. Rehearsals changed these balances; consult the dated recovery evidence.

All Render services below were free, not suspended, on `feature-issue-39-integration` with automatic deploy disabled at observation time. A branch name does not establish the deployed commit.

| Service | Render service ID | Live commit | Live deploy ID |
| --- | --- | --- | --- |
| mgk-indexer | `srv-d9a9gu6cjfls739fl4e0` | `77764221ef097b8d15d2e375abeb544640359348` | `dep-dbkt80h5efls73fjvddg` |
| mgk-oracle | `srv-dbk6u1c9v7es73bsrlk0` | `edf8b6566362f8927c3d2aceb8c8c4c122ef5d72` | `dep-dbkpns67bikc73fib9eg` |
| mgk-keeper | `srv-dbk6u0bbc2fs73ejiqp0` | `edf8b6566362f8927c3d2aceb8c8c4c122ef5d72` | `dep-dbkpns8u01pc73e05p2g` |
| mgk-maker | `srv-dbkpc5rbc2fs73a0kvpg` | `edf8b6566362f8927c3d2aceb8c8c4c122ef5d72` | `dep-dbkpnsajnfac739ki290` |

The worker pins differ from the indexer pin. Identical SHAs are not required: each actual pin must be recorded and its relevant behavior assessed. The worker diff from `edf8b65` to `41df659` only changes HTTP health-server startup/lifetime and adds tests; trading/settlement logic is unchanged. New CI fixes are not deployed at these recorded pins. Rerun affected evidence after behavior changes. Free instances can sleep; keep health endpoints warm during rehearsals. Indexer storage is ephemeral, so redeployment resets replay and must not be used merely to align SHAs or update documentation.

## Frontend preview

The D′ trading preview is [mgk-frontend-lp15mqic5](https://mgk-frontend-lp15mqic5-gadillacers-projects.vercel.app/trade), deployment `dpl_8pS4Mbf4aHnEU6AQa2bwu4ioWgPV`, source commit `bb5ebfd` as recorded in the operator handoff. It uses the D′ manifest, `https://mgk-indexer.onrender.com` and the public devnet RPC through deployment-specific settings. Production frontend settings were unchanged.

The paused/unpaused screenshots qualify that preview only. A new frontend deployment or changed worker behavior requires repeating the affected gates. The browser smoke suite checks hydration/navigation with external requests intercepted; it is not live chain evidence.

## Validation of follow-up CI fixes

The prior frontend CI failed with an empty RPC variable and obsolete maintenance-page assertions. The prior candidate runtime CI encountered health-port collisions when concurrent worker loops implicitly hosted port 10000. Follow-up changes fall back to devnet for an empty RPC, check the restored trading shell, and enable worker HTTP health hosting only with an explicit `PORT`, closing it when the loop exits.

Local validation: tools 153 passed; web 488 passed; typecheck, lint and production build passed; browser smoke 5 passed with external services intercepted; `cargo +stable clippy --all-targets --all-features -- -D warnings` passed before `cargo +stable test --all-features` (625 passed, 6 ignored). Lint retains an existing unused `BOOK_PDA` warning. The signed validator runtime suite was not run by the agent; hosted CI must verify it. The known local SBF layout-build rustc-version limitation is separate from the diagnosed CI failure.

Hosted CI subsequently passed for `41df659831c84b1db2b22b76da47f4d0be386d74`, freshly checked with `gh pr checks 72` at 12:22 UTC: [candidate SBF runtime smoke and Rust tests/lint](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41632790023), [frontend tests and layout fixtures](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41632790027), and [browser smoke](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41632790115). Both Vercel previews passed too. This supersedes the earlier pending-CI observation above.

Recovery transaction details and audit limits are in the readiness assessment. Passing CI does not imply live release-gate completion.

## Indexer follow-up deployment — 12:32 UTC

Render confirmed the indexer performance/status deployment live at 12:32:19 UTC. The [sanitized deployment observation](../../ops/evidence/issue-39-2026-11-03/indexer-7776422-deployment.json) records the new pin and three successful status requests (797–1,456 ms). The D′ preview now displays the actual delayed-batch and low-fee-SOL warnings; [browser evidence](../../ops/evidence/issue-39-2026-11-03/p031-fees-batch-banner.png) accompanies the [critical status](../../ops/evidence/issue-39-2026-11-03/p031-followup-fees-status.json). This performance deployment reset ephemeral replay storage, as expected. Catch-up and external alert delivery remain separate verification requirements. No worker or program upgrade occurred.

All hosted checks subsequently passed for `7776422`, verified with `gh pr checks 72` at 12:39 UTC: [SBF/Rust](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41636351383), [browser](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41636351459), and [frontend/layout](https://github.com/mangekyou-labs/mgk-protocol/actions/runs/41636351564). The [hosted replay measurement](../../ops/evidence/issue-39-2026-11-03/indexer-hosted-7776422.json) shows 26.41 slots/s against chain growth of 4.19 slots/s over 126 seconds. Replay remains incomplete.

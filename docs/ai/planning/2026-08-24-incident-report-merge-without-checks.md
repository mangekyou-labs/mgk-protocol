---
phase: planning
title: "Incident Report: PR #1 Merged With Failing Vercel Checks"
description: >
  Post-mortem for premature merge of feature-dfba-auction into master while
  Vercel deployment checks were failing. Documents root causes and action
  items to prevent recurrence.
date: 2026-08-24
severity: high
status: open
---

# Incident Report: PR #1 Merged With Failing Vercel Checks

**Date:** 2026-08-24
**PR:** [#1 — feat: DFBA public devnet release - T9.11 rollout](https://github.com/gadillacers/mgk-solana/pull/1)
**Merged by:** MrSufferer (Kyler)
**Merge time:** 2026-08-24T14:42:12Z

---

## Summary

PR #1 (`feature-dfba-auction` → `master`) was merged into `master` while **3 out of 4 Vercel deployment checks were failing**. Only `Vercel Preview Comments` passed. This should never have been allowed.

## Failing Checks at Merge Time

| Check | Status | Details |
|-------|--------|---------|
| Vercel | ❌ FAILURE | `vercel.json` schema validation failed |
| Vercel – mgk-frontend | ❌ FAILURE | `vercel.json` schema validation failed |
| Vercel – percolator | ❌ FAILURE | `vercel.json` schema validation failed |
| Vercel Preview Comments | ✅ PASS | — |

## Root Causes

### 1. `vercel.json` contained invalid `engines` property (Vercel root cause)

The root `vercel.json` included:
```json
"engines": { "node": "22.x" }
```

The official Vercel schema (`https://openapi.vercel.sh/vercel.json`) uses `additionalProperties: false`. **`engines` is not a valid property** in `vercel.json`. Vercel rejected every deployment with:
> `The vercel.json schema validation failed ... should NOT have additional property engines`

Node pinning belongs in `package.json` `engines.node`, not `vercel.json`.

Additionally, the root `vercel.json` included a deprecated `env` block with hardcoded program IDs that are redundant with `mgk-frontend/apps/web/lib/config.ts` `DEVNET_DEFAULTS` and dashboard env vars.

**Recovery (T9.11.8b):** Removed `engines` and `env` from `vercel.json`; added `$schema` declaration; pinned Node via `package.json` `engines.node = "22.x"`.

### 2. No Branch Protection on `master`
- The `master` branch has **zero branch protection rules**.
- GitHub returned `"Branch not protected"` (404) from the branch protection API.
- No required status checks, no review requirements, no merge restrictions.

### 3. CI Workflows Target Wrong Branches
- Both `.github/workflows/verify.yml` and `.github/workflows/mgk-frontend-ci.yml` trigger on:
  ```yaml
  branches: [main, develop]
  ```
- The default branch is **`master`**, not `main`.
- This means CI **never runs** for PRs targeting `master`.

**Recovery (T9.11.8b):** Copied corrected workflow triggers from dirty primary: `branches: [master]` in both workflows.

### 4. No Auto-Merge Bot or Merge Guard
- `autoMergeRequest: null` — GitHub auto-merge was not enabled.
- No merge queue, no Mergify, no custom bot.
- Nothing prevented a manual merge regardless of check status.

### 5. Agent Process Failure
- The merge was performed without verifying that all Vercel deployment checks passed.
- A PR should never be merged with failing deployment checks, especially for a public devnet release.

---

## Impact

- `master` now contains code from `feature-dfba-auction` that failed Vercel builds.
- Vercel deployments for `percolator` and `mgk-frontend` were broken due to schema validation failure.
- The `verify.yml` CI workflow was silently non-functional against `master`.
- Live site `mgkprotocol.vercel.app` still serves the prior healthy deploy (HTTP 200, ~8 day `age`) because production target was ERROR.

---

## Action Items

### P0 — Immediate (Before Next Release)

- [x] **Fix `vercel.json` schema** — removed `engines` and `env`; added `$schema`; pinned Node in `package.json` (T9.11.8b)
- [x] **Fix CI workflow branch triggers** — both `verify.yml` and `mgk-frontend-ci.yml` now target `master` (T9.11.8b)
- [ ] **Verify Vercel deployments are working** — need green preview from feature branch push before claiming fixed (IN PROGRESS)
- [ ] **PATCH `mgk-solana` Vercel project** — Root Directory empty, production branch `master` (after schema fix, before claiming all checks green)

### P1 — Next Sprint

- [ ] **Enable branch protection on `master`** with required status checks (document only; not enabled without explicit user request)
- [ ] **Add required reviewers** to branch protection (at least 1 approval for `master`).
- [ ] **Enable "Require status checks to pass before merging"** — specifically the Vercel checks.
- [ ] **Consider enabling "Require branches to be up to date before merging"** to prevent stale merges.
- [ ] **Add `delete_branch_on_merge` = true** for the repo to keep branch list clean.

### P2 — Hardening

- [ ] **Set up a merge queue** (GitHub native or Mergify) to batch and validate merges.
- [ ] **Add a GitHub Actions workflow** that verifies all required checks passed before allowing merge (defense-in-depth).
- [ ] **Audit all workflow files** to ensure they trigger on the correct branch (`master`).
- [ ] **Document the merge process** in AGENTS.md or a contributing guide:
  > Before merging any PR to `master`, verify ALL CI and deployment checks are green. Never merge with failing checks.

---

## Lessons Learned

1. **`vercel.json` is schema-validated.** The official schema uses `additionalProperties: false`. Only documented properties are accepted; `engines` is not among them. Use `package.json` `engines.node` for Node pinning.
2. **Branch protection is not optional.** Without it, any agent or human can merge anything at any time.
3. **CI branch triggers must match the actual default branch.** A mismatch means CI never runs and provides zero protection.
4. **Deployment checks matter.** Failing Vercel deployments mean the production/preview sites are broken — merging into `master` compounds the problem.
5. **Always verify check status before merging.** This is non-negotiable for any automated agent or human process.
6. **Redundant `env` in `vercel.json` is deprecated.** Program IDs live in `config.ts` `DEVNET_DEFAULTS`; dashboard has `NEXT_PUBLIC_INDEXER_URL` and `NEXT_PUBLIC_RPC_URL`.

---

## Current Repository Settings (as of 2026-08-24)

```json
{
  "allow_merge_commit": true,
  "allow_squash_merge": true,
  "allow_rebase_merge": true,
  "delete_branch_on_merge": false,
  "branch_protection": "NONE"
}
```

**CI Workflows (fixed in T9.11.8b):**
- `verify.yml`: triggers on `master` ✅
- `mgk-frontend-ci.yml`: triggers on `master` ✅

**Vercel Checks (GitHub status contexts):**
- `Vercel`
- `Vercel – mgk-frontend`
- `Vercel – percolator`
- `Vercel Preview Comments`

**Vercel Projects:**
- `mgk-frontend` — canonical domain owner (`mgkprotocol.vercel.app`)
- `percolator` — legacy, Root Directory None, all recent deploys ERROR (same schema issue)
- `mgk-solana` — legacy, Root Directory `ui/`, prod branch `main` → needs PATCH to Root empty + branch `master`

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
| Vercel | ❌ FAILURE | Deployment failed |
| Vercel – mgk-frontend | ❌ FAILURE | Deployment failed |
| Vercel – percolator | ❌ FAILURE | Deployment failed |
| Vercel Preview Comments | ✅ PASS | — |

## Root Causes

### 1. No Branch Protection on `master`
- The `master` branch has **zero branch protection rules**.
- GitHub returned `"Branch not protected"` (404) from the branch protection API.
- No required status checks, no review requirements, no merge restrictions.

### 2. CI Workflows Target Wrong Branches
- Both `.github/workflows/verify.yml` and `.github/workflows/mgk-frontend-ci.yml` trigger on:
  ```yaml
  branches: [main, develop]
  ```
- The default branch is **`master`**, not `main`.
- This means CI **never runs** for PRs targeting `master`.

### 3. No Auto-Merge Bot or Merge Guard
- `autoMergeRequest: null` — GitHub auto-merge was not enabled.
- No merge queue, no Mergify, no custom bot.
- Nothing prevented a manual merge regardless of check status.

### 4. Agent Process Failure
- The merge was performed without verifying that all Vercel deployment checks passed.
- A PR should never be merged with failing deployment checks, especially for a public devnet release.

---

## Impact

- `master` now contains code from `feature-dfba-auction` that failed Vercel builds.
- Vercel deployments for `percolator` and `mgk-frontend` may be broken on the production/deployment branches.
- The `verify.yml` CI workflow has been silently non-functional against `master`.

---

## Action Items

### P0 — Immediate (Before Next Release)

- [ ] **Enable branch protection on `master`** with required status checks:
  - Vercel deployment must pass
  - Vercel – mgk-frontend must pass
  - Vercel – percolator must pass
- [x] **Fix CI workflow branch triggers** in both `.github/workflows/verify.yml` and `.github/workflows/mgk-frontend-ci.yml`:
  ```yaml
  # BEFORE (broken)
  branches: [main, develop]
  
  # AFTER (correct)
  branches: [master]
  ```
  *(Fixed & merged to `master` in PR #2 `25951f3`)*
- [x] **Verify Vercel deployments are working** on `master` after the merge — investigated and fixed schema in PR #2; `mgk-frontend` and `percolator` production deployments both `state: success`.
- [ ] **Consider reverting PR #1** if Vercel builds remain broken and need to be fixed on a branch first. *(Not needed: forward-fixed and verified green on master)*

### P1 — Next Sprint

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

1. **Branch protection is not optional.** Without it, any agent or human can merge anything at any time.
2. **CI branch triggers must match the actual default branch.** A mismatch means CI never runs and provides zero protection.
3. **Deployment checks matter.** Failing Vercel deployments mean the production/preview sites are broken — merging into `master` compounds the problem.
4. **Always verify check status before merging.** This is non-negotiable for any automated agent or human process.

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

**CI Workflows:**
- `verify.yml`: triggers on `main`, `develop` (WRONG — should be `master`)
- `mgk-frontend-ci.yml`: triggers on `main` (WRONG — should be `master`)

**Vercel Checks (GitHub status contexts):**
- `Vercel`
- `Vercel – mgk-frontend`
- `Vercel – percolator`
- `Vercel Preview Comments`

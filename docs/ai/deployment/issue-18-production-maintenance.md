# Production maintenance and frontend rollback target

Implements [issue #18](https://github.com/mangekyou-labs/mgk-protocol/issues/18)
under the [restricted-demo spec](https://github.com/mangekyou-labs/mgk-protocol/issues/13).

## Behavior of this build

Every route, including `/`, `/trade`, and `/portfolio`, renders the same static
maintenance screen from the root layout. It states that the demo is being rebuilt
and that earlier devnet balances were not carried over. Order, cancellation,
deposit, and withdrawal controls are visibly disabled with an accessible reason.

The layout never mounts routed content, wallet providers, live market components,
or their transaction handlers. There is no environment variable, browser storage,
query parameter, or wallet state that enables trading in this build. Reopening
the demo requires a reviewed source change. This only disables this frontend;
it does not pause on-chain programs or revoke transactions signed elsewhere.

`pnpm -F web e2e` runs the maintenance route suite for this closed build. The
existing live-trading browser suites remain checked in and must be restored to
the Playwright selection when the rebuilt demo ships (issue #34). The maintenance
suite covers all three routes at 375, 768, and 1280 px with a remembered injected
wallet, no wallet requests, no submitted transactions, and no horizontal overflow.

## Release gate

**Production deployment has not been approved or performed by this change.**
Approval of implementation, a PR, or a preview is not production approval.
Do not close issue #18 until the production deployment and rollback record below
are complete.

1. Build this commit, review its preview, and verify the three routes with and
   without JavaScript. Confirm the banner copy and disabled controls, and that
   no wallet prompt or live balance appears.
2. Present the exact commit and preview URL to the user and obtain explicit
   approval to change production. Check that merging or pushing will not ship
   automatically before that approval; use the project's deployment controls.
3. After approval, promote that reviewed build to production. Verify the
   production domains show maintenance on all three routes.
4. Record the immutable deployment ID/URL, source commit, production domains,
   approval, and verification results in the release record below. Retain that
   deployment and confirm it is eligible for Instant Rollback before later
   promoting the rebuilt demo.

## Roll back a later frontend release

Use the recorded maintenance deployment as the frontend rollback target.
In the Vercel project's production deployment tile, choose **Instant Rollback**,
select the recorded maintenance deployment, verify the listed production
domains, then confirm. Verify `/`, `/trade`, and `/portfolio` show maintenance.

The CLI equivalent is `vercel rollback <recorded-maintenance-deployment-id-or-url>`.
Use an explicit recorded target rather than relying on whichever build happens
to be previous. Vercel Hobby limits rollback to the immediately previous
production deployment; confirm the account supports selecting this target if
intermediate releases have been promoted. After rollback, Vercel disables
automatic production-domain assignment until it is restored deliberately.

References: [Instant Rollback](https://vercel.com/docs/instant-rollback),
[rollback CLI](https://vercel.com/docs/cli/rollback).

## Release record

| Evidence | Current state |
| --- | --- |
| Production approval | Pending separate user approval |
| Reviewed commit and preview URL | Record before requesting production approval |
| Maintenance deployment ID and immutable URL | Record after approved deployment |
| Production domains and route verification | Record after approved deployment |
| Instant Rollback eligibility and deployment retention | Verify before later frontend promotion |

This record deliberately makes no claim that a production rollback target
already exists. Complete it with observed deployment evidence after approval.

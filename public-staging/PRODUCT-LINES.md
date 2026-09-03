# Production Web public-candidate boundary

This candidate contains one public product line: the invitation-only Binance Futures Review Web app. It includes the
complete browser source, focused tests, and the minimum deterministic engine needed to build the production `app/dist`.
The Windows connector and private desktop shell are optional, separate products and are not runtime dependencies.

## Included surface

- `app/`: all reviewed production browser source and tests for authentication, local CSV parsing, encrypted vault sync,
  workspace recovery, review/action/journal/guard loops, reports, backups, and deletion controls.
- `frontend/engine.js` plus its declared browser modules: deterministic import and calculation code required by the app.
- The isolated production-vault SQL baseline, `delete-account` and `publish-vault-head` Edge Function source, deployment
  runbook, and their static/live-gate tests. No legacy database migration is included.
- Public governance, privacy, security, contribution, support, licensing, exact-allowlist exporter, candidate/history gates,
  lockfile, pinned CI/no-data Pages workflow, and the dedicated-origin Vercel configuration.

## Excluded surface

- Generated `app/dist`, source maps, `.env` files, credentials, real trading data, account screenshots, caches, logs,
  internal fixtures, private Git history, reports, research/strategy files, and commercial operations documents.
- Legacy Supabase migrations/functions, Edge Function deployment state, service-role credentials, project IDs, test users,
  and billing details. The production app may connect only to the separately provisioned Supabase HTTPS origin configured
  in the dedicated Vercel project's production environment.
- The private desktop shell, Windows connector, DPAPI credential store, and any trade-execution capability.

## Dependency and release rules

The browser app may import only allowlisted sources and declared public dependencies. Release requires a clean frozen
install, focused tests, typecheck, production build, exact-tree candidate scan, complete-history privacy scan, strict CSP
and response-header inspection, and a `release.json` bound to the full public commit SHA, backend ref, app origin and
live-gate receipt. These gates do not authorize candidate
export, repository mutation, push, backend creation, billing, or deployment.

The machine-readable delivery state is in `DISTRIBUTION.md`; this production candidate is currently
`STATUS: not_distributed`.

## Honest boundaries

1. Publishing the reviewed backend source makes the deployment reproducible, but does not create a Supabase project,
   configure Auth, provision users/secrets, or prove that the separately operated backend is available.
2. Unit/CI coverage and synthetic data do not prove live two-user isolation, full exchange-ledger coverage, or service uptime.
3. Client-side encryption cannot recover data after the user loses every recovery secret and every unlocked device.
4. The runtime-license inventory covers the deployed browser closure; build/test-only dependencies remain `NOASSERTION`
   and require fresh review whenever the toolchain changes.

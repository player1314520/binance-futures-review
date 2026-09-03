# Restore v2 private recovery plane

This Edge Function is the private recovery and deletion control plane. It has
no CORS surface on operator routes and accepts only service-role or explicitly
verified recovery requests. The sole browser exception is exact owner-recover
`POST`/`OPTIONS` from `https://binance-futures-review-web.vercel.app`, with a
fixed header allowlist and no credentialed-cookie mode. The Supabase service
role is never given to GitHub Actions or a browser. Legacy v1 manifests are
`LEGACY_UNTRUSTED` and cannot publish.

Because this function performs its own service-role or user JWT verification,
deployment keeps the gateway JWT switch disabled but the handler never reads a
POST body before route, method, and route-specific authentication succeed.
Operator routes may read at most 7 MiB only after service authentication;
owner claim and owner recovery are capped at 2,048 and 1,024 bytes. Unknown,
encoded, arbitrarily prefixed, wrong-method, missing-token, and wrong-token
requests are rejected without calling the body reader. These bounds reduce an
unauthenticated Edge CPU/memory/free-quota exhaustion path; they are not a
substitute for provider-side rate limits and monitoring.

The Edge deployment must set `RESTORE_V2_USER_ORIGIN` exactly to
`https://binance-futures-review-web.vercel.app`. Runtime initialization fails
closed with `OPERATION_UNAVAILABLE` when it is missing or differs, so this
non-secret binding belongs in the reviewed Supabase function environment.
The empty restore target must also receive the source deployment's
`rv2_restore_v2_recovery_pepper` through the separate offline secret-custody
procedure before owner recovery. It is never included in a backup, workflow,
browser request, response, or log; missing or different custody material makes
the recovery-tag match fail closed.

## Implemented v2 chain

The source schema is installed in this order:

1. `20260831000100_invite_beta_rv2_data_plane.sql`
2. `20260831000200_restore_v2_lineage.sql`
3. `20260831000300_invite_beta_capacity_observability.sql`

A restore target must apply all three migrations in that order before staging
any rows. Capacity observations are environment-specific operational evidence;
they are not copied from the source backup into a restored environment. Until a
fresh observation is recorded in the target, external usage remains unknown and
the 003 resource guard fails closed for admission and history backfill.

The v2 backup path freezes a server-side export, pages at most 250 rows, records
each page receipt, binds the generation audit fields and trade identity/read
model lineage, proves the private R2 deletion journal with two stable passes,
uploads only age ciphertext, and requests a domain-separated Ed25519 signature
from the Edge-held key. The production backup workflow calls
`backup-runner-v2.mjs`; the v1 runner is legacy test coverage only.

Public business/account deletion uses the reviewed recent-OTP/capability
controller and then performs this mandatory order:

1. prepare or replay the v2 deletion intent;
2. append the exact canonical JSON-plus-LF event to private R2 with
   `If-None-Match: *`;
3. verify exact `HEAD` metadata and a two-pass range proof;
4. attest and execute the v2 database deletion;
5. close the legacy receipt; for account deletion, delete Auth last.

An absent Auth user does not bypass the journal. Status recovery must replay the
same event and proof before completing the receipt. Current tenant-wide lineage
semantics require an active `OWNER`; non-owner destructive requests fail closed.

Restore v2 additionally requires an ordered content root, stable
tenant/principal/connection lineage, one verified owner recovery claim for each
surviving tenant, deletion suppression before staging, and publication into a
new generation. Binance credentials are never restored; every recovered
connection is `RECONNECT_REQUIRED`.

When staging reaches `AWAITING_OWNER_CLAIMS`, the owner signs in to the official
site, opens Data Center, enters the `restoreId` printed by the operator Runner,
and selects owner recovery. The browser keeps that ID only in the current form
and calls user-only `POST /internal/v2/restore/owner-recover` with exactly
`{restoreId}`. The Edge function accepts only a JWT whose email is verified by
Auth; PostgreSQL derives
the recovery tag from that server-side email, requires one unique staged hash
match, and creates and consumes the compatibility invite material inside one
transaction. The invite claim, its hash, nonce and delivery identifier never
enter the request, response or Runner. Missing, mismatched, cross-user and
ambiguous matches are deliberately indistinguishable `404 not_found` results.
The exact Origin rule is browser isolation, not authentication: the verified
Supabase bearer JWT and the server-side recovery-tag match remain mandatory.
The direct web call uses only `authorization`, `apikey`, and `content-type`;
clients that add `x-client-info` must remove it for this endpoint.

The Runner does not persist decrypted rows between workflow runs. If it stops at
`WAITING_FOR_OWNER_RECOVERY`, the independently approved operator must inject
the offline age identity again as a one-run `beta-restore-operator` environment
secret before rerunning the same manifest and target inputs, then revoke that
secret immediately after the rerun. This repeated temporary injection is a
residual custody risk; the workflow cannot prove provider-side revocation and
the identity must never be placed in repository secrets, logs, or artifacts.

Claim and publish are separate deletion-journal gates. Both proofs start at the
UTC day before the signed snapshot and must end within five minutes of the
database check. The proof code records `rangeEnd` only after its second stable
LIST/HEAD pass and rejects, rather than filters, any listed event outside that
observed horizon. `POST /internal/v2/restore/publish` requires
`{restoreId,journalProof}`; its proof horizon cannot move backwards from the
claim proof. Under the same deletion-budget advisory lock, PostgreSQL rejects
an omitted/new local intent, derives the effective tenant lineage itself,
replaces staging suppression from the final events, and only then writes live
tables. A lost publish response is recovered through status; it must not be
replayed with a claim-time proof.

## Current release state

The code and local regression contracts are wired, but live status is
`NOT_READY`. No result in this repository proves the Tokyo functions, R2 bucket
privacy/lifecycle, Ed25519 key custody, Brevo delivery, two-user deletion, or an
empty-project restore against real providers. The CLI restore-v2 runner remains
an inspection/sequence component until that isolated live drill is completed.

## Honest boundaries

- R2 Standard is not WORM. Conditional writes, exact object digests, `HEAD`, and
  two stable listings detect reviewed failure modes but cannot prevent a
  privileged provider administrator from rewriting storage.
- R2 LIST and a Supabase publish transaction have no shared atomic fence. The
  mandatory final re-proof closes the claim-to-publish window and the database
  lock closes same-project intents, but a cross-project append immediately
  after the last LIST remains a provider-boundary risk. Until an isolated live
  drill proves the operational source-deletion freeze/fence, restore stays
  `NOT_READY` rather than claiming atomic provider behavior.
- Local and mock verification cannot prove provider configuration, deletion
  propagation, Tokyo residency, Auth identity recovery, RPO, or RTO.
- Restore v2 cannot recover Binance API secrets, sessions, SMTP state, Auth
  passwords, or provider-side copies; users must reconnect Binance.
- Self-recovery intentionally rejects a verified email that uniquely matches
  zero or more than one pending owner lineage. The `{restoreId}` endpoint cannot
  choose between multiple principals; resolving that case requires a separately
  reviewed operator recovery flow and must not weaken the non-enumeration rule.
- A 30-day journal lifecycle protects only restores whose selected backup and
  deletion range are still covered. Missing or stale range evidence blocks
  publication.
- The proof window starts at the UTC day before the snapshot. Deletions before
  that overlap are already reflected in the frozen snapshot; events after the
  snapshot are applied before staging so an old backup cannot resurrect them.
  A serialized 32-day database budget stops new admission and `CLEAR` at 4,086,
  reserves ten account-erasure slots, accepts at most 4,096 proof objects, and
  fails closed at 4,097. This bound assumes the enforced 30-day backup
  retention; extending retention requires a reviewed protocol migration.

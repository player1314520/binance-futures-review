# Destructive-data Edge Function v3 + external deletion journal v2

This function is the only browser-facing boundary for workspace deletion,
business-data deletion, and permanent Auth-account deletion. **Do not deploy it
to either existing Supabase project.** It belongs only to the new, dedicated,
disposable Review Workbench project after
`migrations/20260829000100_production_vault.sql` and the static gates pass. Deploying
there is what makes the two-real-user live gate possible; that gate must pass
before any production promotion or investor invitation.

## Authentication and the manual JWT exception

`supabase/config.toml` sets `verify_jwt = false` deliberately. Every mutation
still verifies the exact bearer token against Supabase Auth, binds its
`session_id` to a currently existing `auth.sessions` row, and requires a recent
email OTP. A signed-out or revoked session therefore fails before any
destructive SQL boundary even if its stateless access token has not expired.
Only `deletion_status` can omit a JWT: the 256-bit, one-hour
recovery capability authorizes a status lookup after an Auth identity or
workspace has already disappeared. Re-enabling gateway JWT verification would
break lost-response recovery.

An exact `APP_ORIGIN` is also required, but **Origin is not authentication**.
Non-browser clients can forge that header. It is a browser isolation/CORS
control; recent OTP protects mutations and the high-entropy capability protects
status. The handler applies one ten-second total deadline across a chunked
request body and every sequential Auth/PostgREST/Admin call. Bodies stop at
1 KiB and upstream responses at 64 KiB. No path logs a JWT, email, subject,
recovery secret, service-role value, or response body.

## Protocol

All bodies use `protocolVersion: 3`, exact keys, UUIDv4 request IDs, and a
`rvr1_` recovery secret containing 256 random bits.

| Action | Additional request fields | Successful response |
| --- | --- | --- |
| `delete_workspace` | confirmation, `workspaceId`, `requestId`, `recoverySecret` | completed state, stable `receiptId`, `expiresAt` |
| `clear_business_data` | confirmation, `requestId`, `recoverySecret` | completed state, stable `receiptId`, `expiresAt` |
| `delete_account` | confirmation, `requestId`, `recoverySecret` | completed state, stable `receiptId`, `expiresAt` |
| `deletion_status` | `operation`, same capability, `subjectHint`; workspace status also has `workspaceId` | pending/deleting state, or the same completed receipt |

The account recovery file is downloaded before a server row exists, so it
cannot contain or promise the eventual `expiresAt`. Its local import envelope
is derived from the five-minute preparation window, the browser's validated
15-second maximum timeout, this function's ten-second maximum deadline, and the
60-minute row TTL. This prevents product-controlled deadlines from expiring the
file before a possible row, but it is not a provider-routing guarantee. Once a
status response exists, its `expiresAt` (or an authoritative `410`) controls;
refreshing or re-importing a file never extends the server capability.

The three exact confirmations are `DELETE_THIS_WORKSPACE`,
`DELETE_MY_REVIEW_DATA`, and `DELETE_MY_ACCOUNT`. Mutation requests never carry
a subject. The function binds every service-only RPC to the Auth-verified JWT
subject/session and rejects anonymous, refresh-only, stale, malformed,
subject-mismatched, signed-out, or revoked proof. Session existence is checked
when the capability row begins, again inside workspace/business deletion, and
again before account deletion enters its irreversible Auth Admin phase.

Before any mutation, the function stores only keyed HMAC-SHA-256 fingerprints
of capability, subject, and operation scope plus an operation label, random
IDs, state, and timestamps. It never stores a UID, workspace UUID, email, JWT,
or raw recovery secret in `destructive_operation_requests`.

Workspace deletion continues to use the atomic
`rv_service_execute_workspace_deletion` path. Business-data and account
deletion use the v3 recent-OTP/capability row as their public controller, but
the legacy receipt RPCs no longer delete rv2 data directly. Before either
receipt can complete, Edge must prepare or replay the receipt-bound restore-v2
intent, append its exact canonical JSON-plus-LF bytes to private R2 with
`If-None-Match: *`, verify exact `HEAD` metadata and two stable range-proof
passes, attest that evidence, and execute the service-only v2 database delete.
Only then may it close the legacy receipt. Business-data deletion retains Auth.

Account deletion cannot be atomic with Auth Admin. Its row is marked deleting
only after the v2 journal and database deletion succeed, and Auth Admin deletion
is always last. If the Admin response is lost, `deletion_status` checks the
capability-bound subject and replays the same journal event before advancing the
receipt. An absent Auth user alone is not deletion evidence: an out-of-band Auth
deletion without the journal remains unavailable instead of silently completing.
A wrong capability or scope returns the same non-enumerating `404`.

The restore-v2 journal currently suppresses a whole tenant lineage. This
personal/invite Beta therefore provisions exactly one immutable `OWNER`
membership per dedicated tenant, including inactive historical membership
rows. `ADMIN` and `MEMBER` contexts fail closed before deletion dependencies.
Business/account deletion applies only to that caller's dedicated tenant;
shared tenants and member-level deletion remain `NOT_READY` and require a
different lineage and tombstone model.

## Required secrets, rate limits, and cost controls

Set `APP_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, an independent
high-entropy `DELETION_HMAC_SECRET`, `DELETION_R2_ACCOUNT_ID`,
`DELETION_R2_API_TOKEN`, `DELETION_R2_PARENT_ACCESS_KEY_ID`, and
`DELETION_R2_BUCKET` in the Edge secret manager. None belongs in a Vite
variable, repository file, GitHub variable, browser, log, or command example.
The Cloudflare parent values mint a 120-second prefix-scoped credential inside
Edge; GitHub Actions and browsers never receive the parent token or service role.
HMAC rotation invalidates outstanding one-hour capabilities, so either drain
the window or explicitly accept lost status recovery during an incident.

The database enforces destructive subject/session buckets of 10/minute and a
ten-slot transaction semaphore. Known deletion-status capabilities have an
isolated 10/minute bucket; unknown probes share a 60/minute global bucket and
cannot consume the known-capability pool. `P0004` and `P0005` both map to a
generic retryable `429` with `Retry-After: 1`, without exposing the subject,
scope, workspace, or capability. Supabase Auth separately enforces the reviewed
six OTP send/verify operations per hour.

Restore-v2 also serializes new deletion intents under one global
32-day journal budget: one `CLEAR` per tenant per 24 hours, admission and
additional `CLEAR` stop at 4,086 objects, and the final ten slots are reserved
for one `DELETE_ACCOUNT` per active subject. The 4,096-object boundary matches
the background proof; a 4,097th event fails closed. Foreground deletion remains
constant-size because it lists only the exact receipt object.

These controls run at the database boundary. They are not trusted-IP, Edge
invocation, or whole-project limits, and no client-supplied forwarding header is
used as identity. PostgreSQL rolls back token consumption when a later error in
the same statement raises, so authenticated invalid attempts are concurrency-
bounded but not durably counted by these buckets. On Supabase Free there is no
overage billing, monetary spend cap, or arbitrary dollar alert; quota exhaustion
can restrict or pause service. Monitor Free-plan entitlement/quota state,
invocations, 4xx/5xx rate, Auth Admin calls, database egress, p95 duration,
admission rejections, and cron health. A plan/add-on change, exhausted quota,
unexplained spike, or sustained probe flood is a release stop condition. Never
weaken capability checks merely to reduce cost.

Expired rows are not pruned on mutation/status requests: a global cleanup scan
must never consume the same ten-second recovery deadline. Operate the
service-role-only `rv_prune_destructive_operation_requests()` from a monitored
schedule; each call uses the expiry index, locks with `SKIP LOCKED`, and deletes
at most 500 rows. Repeat until it returns zero, with a run-time/concurrency cap.

## Live release gate

Use two real users created only as disposable, synthetic release identities in
the new project. The destructive
acknowledgement must name the exact project ref and authorize deletion of test
user A. The live gate must prove:

- recent numeric OTP permits each mutation only for its own subject;
- after cancelling the first deployed mutation response body before reading a
  receipt, workspace status and replay return one receipt while user B's same
  UUID workspace remains readable;
- after cancelling the first response body, business-data status proves only
  caller A's journal object was conditionally appended and independently
  re-read, only A's application rows were removed, and A's Auth identity remains;
- after cancelling the first response body, account status without JWT proves
  the same journal event is replayed before completion, only test user A was
  deleted, and test user B remains authenticated and readable;
- missing/invalid JWT and an unknown status capability fail closed;
- a locally revoked test-user session cannot start any destructive mutation;
- responses, logs, and retained rows contain no credentials or user content.

The live driver cancels a real deployed response body after headers, but cannot
force every packet-loss timing. Static tests additionally inject a failure
after the database/Auth commit and cover wrong phrases, extra keys,
oversized/stalled chunks, stale proof, foreign Origin, wrong capability, and
wrong scope. Static and live evidence must be reported separately; neither is
provider-retention evidence.

## Honest boundaries

- A five-minute OTP ceremony cannot protect a user whose mailbox and active
  browser are both controlled by an attacker; passkey/MFA step-up is stronger.
- A same-origin script compromise can steal the session-stored recovery
  capability. Losing that capability makes final-state lookup unavailable after
  its short expiry.
- The receipt proves this state machine observed a committed application delete.
  It cannot prove erasure from provider backups, Auth/email logs, browser
  downloads, user exports, or legally retained records.
- R2 Standard is not WORM. Conditional PUT, exact `HEAD`, object re-read, and
  two stable listings detect the reviewed failure modes but cannot prevent a
  privileged storage administrator from rewriting or deleting objects.
- The ten-second foreground path lists, `HEAD`s and re-reads only the exact
  newly appended object. Full-journal enumeration belongs to the private
  backup job, so another tenant cannot inflate a user deletion into an
  unbounded scan.
- The dedicated-OWNER model cannot provide member-scoped erasure in a shared
  tenant. Shared tenants, role delegation, and member deletion are `NOT_READY`;
  expanding beyond the personal/invite Beta needs a new deletion-lineage model
  and separate acceptance tests.
- Expired HMAC fingerprints remain until the separately operated, monitored,
  bounded cleanup runs. That schedule is necessary even on a quiet project and
  is not proof of provider-backup erasure.
- Origin checking does not stop scripts, bots, or forged non-browser requests;
  database admission, Free-plan quota behavior, OTP, and capability verification
  remain separate controls.
- The live gate proves only one deployed version at one time. It does not prove
  future configuration, provider retention, billing behavior, or secret
  isolation.

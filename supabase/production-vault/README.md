# Production vault baseline

This document defines the **new, independent production data plane** for the
Review Workbench web product. Its frozen, forward-only baseline is the standard
Supabase migration `migrations/20260829000100_production_vault.sql`, followed
by `migrations/20260830000100_vault_objects_device_fkey_index.sql`,
`migrations/20260830000200_free_plan_admission_controls.sql`,
`migrations/20260830000300_status_fairness_and_admission_truth.sql`, and
`migrations/20260830000400_close_status_lookup_admission_gap.sql`. The
privacy-gated public exporter materializes the same bytes at the corresponding
standard public project paths under `supabase/migrations/`.

## Hard deployment rule

Apply the materialized public migration only to a newly created, dedicated
Supabase project through the reviewed migration chain. Never run `supabase db
push` from the private source root: that root intentionally retains the legacy
single-owner migration history for audit and compatibility.
Never apply it to an existing shared/legacy project. The preflight
guard rejects known legacy tables and partial installs; do not remove or bypass
that guard. A committed migration is a deployable contract, not proof that it
has run on the intended project; live inspection remains mandatory.

Before production traffic, validate the exact deployed project with two real
test users:

1. Both users create the same workspace, device, and object UUIDs and remain
   isolated; anonymous requests cannot read tables or execute RPCs.
2. A wrong write capability cannot register a device or upload an object. A
   valid Ed25519-signed candidate publishes only through `publish-vault-head`;
   tampering, a stale parent, replay, and a forged/foreign subject are rejected.
   Two concurrent successors produce one winner and one SQLSTATE `40001` loser.
3. Workspace deletion and business-data deletion go through the v3
   `delete-account` Edge endpoint with a recent email OTP and a short-lived
   recovery capability. Browser JWTs cannot directly execute the service RPCs.
4. `delete_workspace` removes only the verified subject's selected workspace;
   `clear_business_data` removes only that subject's profile, workspaces,
   devices, objects, and heads while preserving `auth.users` and the second
   user's rows.
5. The 17th workspace, 17th device in one workspace, 2049th vault object, an
   object over 24 MiB, and a user total over 512 MiB are rejected under
   concurrent insert load without disclosing tenant identifiers.
6. Workspace, business-data, and permanent-account deletion each return one
   stable receipt across replay and lost-response recovery; the live gate in
   `functions/delete-account` deletes only disposable test user A.

## Data and quota contract

- `profiles` contains only an opaque identifier, schema version, and timestamp;
  workspace labels and trading content remain encrypted.
- Each workspace additionally pins one immutable `ed25519-v1` SPKI public key
  and the SHA-256 hash of a random 256-bit write capability. The plaintext
  capability and Ed25519 private key never leave the browser/recovery envelope.
- `devices` contains opaque identifiers and revocation timestamps only. No
  recovery secret, workspace key, device key, or wrapper is uploaded.
- `vault_objects` contains immutable standard-base64 ciphertext, its
  server-recomputed SHA-256 digest, an Ed25519 signature, and the previous
  object ID/digest needed to authenticate the chain. Trading
  records, review notes, journal entries, reports, file names, and import ranges
  remain inside that ciphertext. A generated `ciphertext_bytes` field supports
  server-side quota accounting.
  A follow-up composite index on `(user_id, workspace_id,
  created_by_device_id)` covers the device foreign key without adding
  redundant four-column indexes to the one-row head tables.
- `vault_heads` is the CAS-controlled active-generation pointer.
- `vault_head_history` contains only candidates that actually won head CAS;
  uploaded losing candidates are never presented as committed history.
- The service-only retention worker always preserves the current head and the
  latest four committed generations per workspace. It reclaims older committed
  objects and uncommitted CAS losers older than 24 hours in locked batches of
  at most 500; it never returns tenant identifiers.
- `destructive_operation_requests` retains one-hour keyed HMAC fingerprints of
  capability, subject, and operation scope plus random receipt state. It has no
  UID, workspace UUID, email, JWT, recovery secret, or user content.
  Its expiry index supports the service-only cleanup RPC, which deletes at most
  500 expired rows per monitored scheduled call; deletion/status requests do
  not perform a global cleanup scan. A private postgres-owned pg_cron wrapper
  runs both bounded cleanup jobs every five minutes and retains only seven days
  of aggregate Cron run details without storing a service key.
- The private forced-RLS `rv_rate_limit_buckets` table stores only
  domain-separated SHA-256 fingerprints and short-lived token state. Vault
  subject/session buckets are 120/minute, destructive subject/session buckets
  are 10/minute, known deletion-status capabilities are 10/minute, and unknown
  status probes share 60/minute. A known capability never consumes the unknown
  global bucket, so unknown committed responses cannot consume a valid
  capability's recovery budget. Every status request acquires a database slot
  before the keyed operation-state lookup; its bucket is chosen only after that
  lookup. The bucket therefore limits committed response throughput, not
  pre-database attempts or Edge traffic.
- Every user-facing vault database transaction must acquire one of ten
  transaction-scoped advisory-lock slots. `P0004` (bucket) and `P0005`
  (capacity) are both returned as retryable, definitely-not-applied refusals.
  This is not an Edge, IP, or whole-project concurrency limit.

Hard limits are 16 workspaces per user, 16 devices per workspace, 2,048
immutable objects per user, 24 MiB per encrypted object, and 512 MiB total
ciphertext per user. A `SECURITY DEFINER` trigger takes a tenant-scoped
`pg_advisory_xact_lock` before counting, so concurrent inserts cannot each pass
an application-visible pre-check and over-allocate. Its public error is only
`tenant quota exceeded`; it does not include a UID, workspace ID, device ID, or
object ID.

The browser never writes tables directly. It calls
`rv_bootstrap_workspace`, `rv_register_device`, and
`rv_upload_vault_generation`; each mutation is scoped to `auth.uid()`, requires
the exact UUID `session_id` claim from that bearer JWT, and rechecks the live
`auth.sessions` row inside the mutation transaction. The latter two also
require the 64-lowercase-hex write capability whose SHA-256 must match the
workspace root. The upload RPC decodes the standard-base64
ciphertext, recomputes its SHA-256, checks the signature encoding, verifies the
declared parent exists at generation `N-1`, and then inserts through the same
quota triggers as every other path.

Publishing is a separate authority boundary. The browser sends only
`{protocolVersion:"rv-vault-publish/1", workspaceId, objectId,
expectedGeneration}` to `publish-vault-head`. That Edge Function checks the
exact configured Origin, manually validates the ordinary JWT with
`/auth/v1/user`, strictly extracts that JWT's UUID `session_id`, loads only the
verified subject's root/candidate/head, and verifies the Ed25519 signature before calling service-only
`rv_service_publish_vault_head`. The signed UTF-8 manifest is exactly nine
lines with no trailing newline:

```text
rv-vault-object-signature/1
userId
workspaceId
objectId
generation
envelopeVersion
ciphertextSha256
parentObjectId-or--
parentCiphertextSha256-or--
```

SPKI and signature use canonical base64url without padding. Digests and the
write capability use exactly 64 lowercase hexadecimal characters. Generation
zero means no current head; the candidate must be generation one with no
parent. Every later candidate must be exactly `expected_generation + 1` and
name the current head's exact object ID and digest. Candidate objects from a
lost race remain immutable and are not made active.

Browser vault reads never select the vault tables directly. The four
fixed-search-path read RPCs call the live-session guard, subject/session bucket,
and transaction semaphore before returning only the verified subject's rows. A
missing, expired, or revoked session raises a fail-closed database error rather
than being presented as an empty vault. Direct vault-table SELECT and all direct
table writes remain ungranted; bootstrap, device registration, candidate
upload, and head CAS use the same live-session boundary.

The Edge endpoint deliberately rejects a stale replay. If the network response
is lost, do not blindly retry as though nothing happened: read the signed active
head and object history through the session-bound RPCs, verify that the active object ID,
digest, signature, and parent chain are the attempted candidate, and only then
classify the first call as committed. A different head is a real conflict.

Destructive data RPCs accept a subject only from the Edge Function's service
role after recent-OTP verification. Their execute privilege is revoked from
`public`, `anon`, and `authenticated`; the browser never decides the deletion
subject. Workspace/business deletion and completed receipt are one SQL
transaction, so a lost Edge response is resolved through the same capability.
Permanent identity deletion is handled only by the companion Edge state machine
and Supabase Auth Admin API.

## Honest boundaries

- RLS and quotas protect ordinary API roles, but a database administrator or a
  leaked `service_role` can bypass them. End-to-end confidentiality still
  depends on user-device-only recovery and encryption keys.
- Ciphertext hides content, not metadata: the service observes row sizes,
  timestamps, workspace/device counts, and access timing.
- The static Node checks do not execute PostgreSQL. They cannot prove trigger
  syntax on the target Postgres version, live role grants, advisory-lock
  behavior, Auth configuration, storage policy, backups, or cross-user
  isolation; a disposable-project migration and concurrent live test are
  release gates.
- Immediate JWT revocation intentionally reads the current `auth.sessions`
  contract. Supabase Auth warns consumers not to assume its internal schema is
  stable, so the migration preflights the exact columns and must be rerun in a
  disposable project after every Auth platform upgrade; upstream schema drift
  blocks release instead of silently weakening revocation. See the
  [Supabase Auth compatibility guidance](https://github.com/supabase/auth#inherited-features).
- The retention policy is intentionally finite: versions older than the latest
  four committed generations are not a long-term audit archive. User-downloaded
  backups remain outside server retention and must be protected separately.
- Account deletion cannot erase prior user exports, browser downloads,
  provider-managed Auth/email audit logs, backups, or independently retained
  legal records.
- The legacy production-vault data plane stores no Binance API credential and
  performs no exchange synchronization. The additive rv2 Beta plane described
  below is a separately reviewed, service-readable boundary.
- The current recovery protocol does not provide trusted-device approval or
  passwordless device-to-device key transfer.
- Device registration is audit metadata, not a complete revocation system. A
  client that retained the workspace signing private key can still sign until
  the product ships a reviewed key-rotation/revocation protocol; do not claim
  `revoked_at` alone can invalidate a copied signing key.
- The signed root detects unauthorized server-side head changes when clients
  verify history, but it cannot make a compromised browser, stolen recovery
  secret, malicious extension, or service worker produce honest content.
- PostgreSQL token consumption is transactional. Calls that raise later in the
  same statement roll their token charge back, so the buckets bound committed
  statement throughput and successful zero-row status probes, not every invalid
  authenticated attempt. The ten-slot semaphore still bounds concurrent
  database work; Free/no-overage and invitation-only Auth reduce cost exposure,
  but a trusted external gateway is required for durable all-attempt/IP limits.

## rv2 invite-only Beta data plane

The forward-only `20260831000100_invite_beta_rv2_data_plane.sql` migration adds
the service-readable USDⓈ-M Beta plane without replacing Classic/DC or deleting
the encrypted vault. Legacy vault browser writes are revoked; reads and destructive-operation recovery remain available.
A user must explicitly decrypt
and migrate an old snapshot in the browser. There is no dual write and no path
from rv2 back into the old vault.

Authentication maps each changing Auth UUID through `rv2_memberships` to a stable,
dedicated personal tenant. Each tenant has exactly one immutable membership,
including inactive history, and its only role is `OWNER`; `ADMIN`, `MEMBER`, and
shared tenants are not part of this Beta. Browser RPCs derive identity from the
verified session and forced RLS; service membership RPCs require the subject,
tenant, and `OWNER` role to agree. Unknown or foreign resource identifiers return
the same non-enumerable not-found result. Admission separately caps active OWNER
memberships (equivalently active personal tenants) and active connections at ten.

`provider_scope_hash` is only a domain-separated credential-scope commitment;
it is not an official Binance UID or account identifier. Permission evidence is
the exact `rv-binance-permission/1` document and must be explicit before a
connection becomes active. UUID idempotency keys bind a request fingerprint:
replaying the same request returns the same result, while reusing a key for a
different request fails before mutation.

Sync state is per connection, dataset, and partition. Attempted, fetched,
committed, and trusted watermarks never advance on failure. Immutable source
events reject a provider-identity/content-digest conflict rather than
overwriting history. The current `rv-cloud-dataset/1` document exposes bounded
execution rows with id, symbol, side, time, price, qty, commission, and
realizedPnl, plus income, orders, positions, reviews, coverage, reconciliation,
and independent capabilities. PARTIAL, STALE, UNKNOWN, or CONFLICT coverage may
permit verified-record browsing, but account KPIs, positions, equity, Ledger,
experiments, and AI remain denied.

Generation publication is a compare-and-swap operation bound to the connection,
credential version, exact completed jobs, coverage, reconciliation, and
capabilities. Review updates also require expected version. Ledger and reconciliation are structural shadow state only
in this migration; no shadow
row may become a primary metric merely because a generation was published.

## rv2 honest boundaries

- Database RLS does not constrain a database administrator or leaked service
  role. Project and deployment administrators can theoretically decrypt
  wrapped Binance credentials while the versioned Project Secret is available.
- Static schema tests cannot prove the migration ran in the intended Tokyo
  project, real two-user isolation, Binance permissions, worker fairness,
  deletion, backup, or restore. Those remain live invite-beta gates.
- Supabase Edge has no fixed egress IP and the Free project may pause; hourly
  sync is a best-effort target, not a real-time or availability SLA.
- Synchronization, archive downloads, and CSV evidence cannot prove that the
  user supplied every trade. Coverage gaps must remain visible and analytical
  capabilities must fail closed.

# Private beta operations control plane

This Edge Function is the private server counterpart for the reviewed GitHub
Actions runners in `scripts/beta-ops`. It is not a browser API and intentionally
has no CORS support, arbitrary URL parameter, arbitrary HTTP method, or generic
proxy route.

## Fixed routes

- `POST /internal/v1/token/exchange`
- `GET /internal/v1/backup/view`
- `POST /internal/v1/r2/private-attestation`
- `POST /internal/v1/backup/sign`
- `GET /internal/v2/backup/view`
- `POST /internal/v2/r2/journal-credentials`
- `POST /internal/v2/backup/sign`
- `POST /internal/v1/capacity/observe`
- `POST /internal/v1/restore/tombstone`
- `POST /internal/v1/restore/manifest-claim`
- `POST /internal/v1/restore/import-batch`
- `POST /internal/v1/restore/finalize`
- `GET /internal/v1/restore/status?restore_id={restoreId}`
- `POST /internal/v1/archive/request`
- `POST /internal/v1/archive/attest`
- `POST /internal/v1/archive/fail`
- `POST /internal/v1/archive/ingest`
- `POST /internal/v1/archive/finalize`

GitHub OIDC is verified against GitHub's fixed JWKS, issuer and `RS256` before
the pure claim validator runs. Direct workflows are bound to the private
repository ID and owner ID, release `workflow_sha`, `workflow_ref`, ref,
environment, event, hosted-runner class, run ID/attempt, JTI, audience, subject
and time window. GitHub's standard direct-workflow token does not reliably carry
a job claim or `job_workflow_ref`; the job is derived from the server policy.
Reusable workflows, if enabled later, must additionally bind both reusable
workflow ref and SHA.

The backup grant and archive grant are different capabilities. Grants and R2
credentials expire in at most 600 seconds and cannot outlive the OIDC token.
R2 credentials are scoped to
`beta-backups/runs/<runId>/attempt-<runAttempt>/`; the Cloudflare parent token
and parent access-key ID remain server-only. The privacy attestation calls the
fixed Cloudflare managed-domain and custom-domain REST endpoints and fails
closed if either response is missing or any public route is configured.

The v1 backup view/sign routes remain only for legacy tests. The scheduled
production workflow calls the v2 frozen-page route, obtains a separate
read-only `deletion-journal/v2/` grant, and uses the domain-separated v2 signing
route. Every page receipt, journal root, ciphertext object `HEAD`, repository,
workflow ref, ref, run ID and attempt must match the same at-most-600-second
backup grant. The runner never receives the service role or the Ed25519 private
key.

`/internal/v1/capacity/observe` uses the independent
`beta-capacity-observe` capability while retaining the exact private
repository/workflow/ref/run/attempt binding of the backup job. Its token never
contains R2 credentials. The route accepts only aggregate
DB/R2/Actions/backup-age/SMTP evidence, a fresh timestamp and a
domain-separated SHA-256. It rejects extra identity fields and calls only
`rv2_service_record_capacity_observation`; DB size is measured inside PostgreSQL.
The repository has no configured live Cloudflare/GitHub/Brevo collectors, so
the workflow currently runs the observer in an explicit zero-request
`NOT_READY_EXTERNAL_PROVIDER_COLLECTORS_UNCONFIGURED` mode. No zero usage value
is synthesized.

Archive ingestion is a two-stage, staged transaction protocol. An exact private
repository/workflow/ref/run/attempt OIDC claim may consume one `PENDING` URL
once. The broker atomically records the run/attempt and clears the stored URL;
expired or abandoned claims are terminalized without returning the URL again.
The runner downloads through one configured HTTPS host with redirects disabled,
computes bytes and SHA-256 locally, then calls the narrow attestation route. If
Binance supplied upstream bytes/SHA-256, both must match; otherwise the persisted
`WORKFLOW_OBSERVED` digest is an observation made by the trusted private workflow,
not a Binance signature. A failed download or parse is terminalized through the
narrow failure route.

Ingest and finalize require the same archive, OIDC run/attempt, and persisted
attestation. Each batch is bound to that claim and the database returns its own
batch digest. Finalize accepts only the ordered digest of a complete contiguous
batch set plus the attested archive bytes/SHA-256. The finalize RPC locks the
archive, verifies every batch index, total-batch value, row count and staging-row
digest, then either inserts the whole deduplicated set into immutable
`rv2_source_events` or inserts none. Provider-identity digest conflicts are
persisted in the conflict register, mark coverage `CONFLICT`, and leave trusted
watermarks unchanged. A successful import remains `PARTIAL` with
`ARCHIVE_RECONCILIATION_PENDING`; it does not publish a generation, unlock KPI,
or move Ledger from shadow mode.

The parser currently recognizes only the explicit normalized header profile
`rv-normalized-archive/1`. Binance documents the asynchronous request/link APIs
but does not publish a stable official archive CSV header fixture in the
reviewed sources. Therefore an unknown filename/header fails closed. A captured
official USD-M fixture must be privacy-cleaned, mapped into a separately named
versioned profile, and regression-tested before live archive compatibility can
be claimed. Signed decimal fields such as income, realized PnL and position
amount remain signed numeric strings; spreadsheet formula expressions and
control characters are rejected rather than rewritten into trading data.

Manifest signing is not a general Ed25519 oracle. Before signing, the handler
uses an exact-object, read-only Cloudflare temporary credential to perform a
SigV4 `HEAD` against the fixed R2 S3 endpoint, verifies `Content-Length` and
`x-amz-meta-rv-sha256`, then requires persistent evidence for the exact grant,
snapshot ID, generation, row counts, run/attempt, server-issued object prefix,
object key, byte count and SHA-256. Missing evidence returns 503.

Restore applies deletion tombstones before accepting a manifest, and the
nonce/digest claim is atomic and single-use. A successful claim returns a
server-signed HMAC restore lease lasting at most 600 seconds. The restore ID,
target generation, manifest digest and tenant subject come from that lease;
request bodies cannot supply a trusted tenant or user identity.

The legacy beta-operations restore-v1 publication path is intentionally
disabled. Valid
import, finalize and status requests return HTTP 503 with
`format=beta-restore-not-ready/1`, `state=NOT_READY`, `published=false`, and
three explicit blockers: unverified tenant lineage, unverified Auth identity
mapping, and no independently live-verified external deletion journal. The handler does not
expose import/finalize/status RPC adapters while this gate is closed. This
prevents an empty-project restore from inventing ownership or resurrecting data
deleted after the last database backup. The existing restore runner treats this
503 as a hard stop; its dry-run can still validate and plan a restore, but that
is not recovery evidence and no live run can report success through this
backend.

## Server secrets

All are Supabase project secrets, never GitHub variables or runner secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `BETA_OPS_GRANT_HMAC_V1`
- `BETA_OPS_RESTORE_TOMBSTONE_HMAC_V1`
- `BETA_OPS_RESTORE_CLAIM_HMAC_V1`
- `BETA_OPS_RESTORE_LEASE_HMAC_V1`
- `BETA_OPS_BACKUP_SIGNING_PRIVATE_KEY_PKCS8_B64`
- `BETA_OPS_CLOUDFLARE_API_TOKEN`
- `BETA_OPS_R2_PARENT_ACCESS_KEY_ID`

The remaining `BETA_OPS_*` configuration values pin repository IDs, workflow
SHA, audience, R2 bucket/prefix, archive download host and public signing key ID.
`readRuntimeConfig` returns `null` unless every value passes its exact format and
the HMAC keys are distinct.

## Required private database contracts

The adapter deliberately calls only these narrow RPCs:

- `rv2_ops_claim_oidc_jti`
- `rv2_ops_read_backup_page`
- `rv2_ops_record_backup_page_evidence`
- `rv2_ops_claim_backup_signing_evidence`
- `rv2_ops_apply_deletion_tombstones`
- `rv2_ops_claim_restore_manifest`
- `rv2_ops_claim_archive_download`
- `rv2_ops_attest_archive_payload`
- `rv2_ops_fail_archive_claim`
- `rv2_ops_ingest_archive_batch`
- `rv2_ops_finalize_archive`
- `rv2_restore_v2_read_backup_page`
- `rv2_restore_v2_record_backup_page_evidence`
- `rv2_restore_v2_claim_backup_signing_evidence`
- `rv2_service_record_capacity_observation`

They must revoke `PUBLIC`, `anon`, and `authenticated` execute privileges,
grant only `service_role`, assert that server role again inside each function,
remain atomically idempotent, and bind every record to the job run/attempt.
`rv2_ops_claim_backup_signing_evidence` must atomically allow only the first
signing attempt and independently prove both the completed snapshot cursor
chain and R2 object bytes/SHA-256; a caller assertion is not evidence. There are
deliberately no runtime RPC adapters for restore import, finalize or published
status in this release. Adding them requires closing all three blockers and
replacing the `NOT_READY` regression tests.

## Honest boundaries

1. This code cannot make a live backup safe until all private RPCs above exist,
   RLS/grants are audited, and the R2 object checksum is independently
   observable; it fails closed meanwhile.
2. This code cannot create Cloudflare, Supabase or GitHub credentials, enable an
   R2 account, or prove provider configuration without live account access.
3. This code cannot provide PITR, fixed egress, real-time sync or an SLA on free
   infrastructure.
4. This code cannot prove restore completion until import/finalize/status RPCs
   atomically publish only a new generation, exclude every credential, verify
   a signed tenant/content lineage and target Auth mapping, mark connections
   for rebinding, and pass a separate live restore test.
5. A passing local unit test cannot prove two-user isolation, real Binance
   history completeness, backup recoverability, or deletion propagation.
6. The v2 external R2 deletion journal, two-pass range proof and public
   journal-first deletion chain are implemented locally, but they are not
   disaster-independent evidence until a real private-bucket deletion and
   restore drill passes. R2 Standard is not WORM.
7. The normalized archive adapter cannot prove compatibility with Binance's
   generated CSV until a real official fixture is reviewed; unknown headers are
   intentionally rejected and CSV fallback remains the evidence path.
8. A `WORKFLOW_OBSERVED` SHA-256 proves what the reviewed private runner saw; it
   is not a Binance digital signature and cannot prove Binance generated the
   bytes if the upstream response did not provide its own digest.
9. The configured archive host is exact and redirects are rejected, but it
   cannot be called an official stable host until a live Binance response is
   captured and the hostname is pinned in deployment evidence.
10. Capacity code cannot truthfully report external usage until pinned provider
    collectors supply fresh R2, GitHub Actions, backup-object and Brevo evidence;
    absence stays `NOT_READY`/stale and is never replaced with fake zeros.
11. The background v2 journal proof uses a lexicographic `start-after` boundary
    at the UTC day before the snapshot, then bounded concurrent `HEAD`/`GET`
    checks. Earlier deletion is already reflected by the frozen snapshot; the
    one-day overlap closes the journal/database race, and post-snapshot events
    are the tombstones required to prevent resurrection. With 30-day backup
    retention the database caps the resulting 32-day window: `CLEAR` is once
    per tenant per 24 hours, admission and `CLEAR` stop at 4,086, ten slots are
    reserved for the at-most-ten active accounts to `DELETE_ACCOUNT`, and
    4,097 fails closed. Lifecycle-delayed older R2 objects therefore cannot
    inflate all future proofs, and relevant objects are never silently skipped.

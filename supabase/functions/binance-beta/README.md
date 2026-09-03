# Binance Beta Edge runtime

This function is the reviewed network boundary for the invite-only USDⓈ-M Beta.
`index.ts` fails closed until every required setting is present, dispatches browser
requests to the public handler, and dispatches exactly two no-CORS scheduler
routes to the internal handler. Binance calls remain limited to fixed HTTPS hosts,
fixed paths, and `GET` method in `binance-client.mjs`.

## Required project secrets

- `APP_ORIGIN=https://binance-futures-review-web.vercel.app`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`
- `RV_BETA_CREDENTIAL_KEK_V1`: base64url-encoded 32 random bytes
- `RV_BETA_SCOPE_HMAC_V1`: a different base64url-encoded 32 random bytes
- `RV_BETA_SYNC_CRON_TOKEN`: a 64-character base64url sync scheduler token
- `RV_BETA_ARCHIVE_CRON_TOKEN`: a different 64-character base64url archive scheduler token
- `RV_BETA_EDGE_WORKER_SUBJECT`: the reviewed UUID used by worker lease RPCs

The KEK, HMAC key, and two scheduler tokens must be generated independently and
stored only as Supabase Project Secrets. Do not put them in Vercel, GitHub, R2,
the database, the browser, examples, or logs. `verify_jwt=false` in
`supabase/config.toml` is intentional: the public handler validates the
canonical Origin and calls Auth itself; each internal route validates its own
fixed-width token with no browser CORS and accepts only an exact scheduler body.

## Runtime contract

- Browser RPCs preserve the user's JWT, so `auth.uid()` and RLS derive the
  tenant. Service-role RPCs accept a verified subject only where the SQL
  function independently verifies active membership.
- Public `trades` is mapped to the SQL `fills` dataset. The seven SQL dataset
  names map to fixed Binance endpoint keys; neither a request nor a job row can
  supply a URL or HTTP method.
- A browser manual-sync request seeds `positions/default`. Only the server-side
  symbol-discovery RPC may then schedule the fixed `fills`, `orders`, and
  `algo_orders` symbol datasets; `fills/default` is rejected at both the public
  adapter and worker claim boundary.
- Provider identifiers, timestamps, and decimals are canonical strings before
  an immutable event reaches SQL. A bounded lossless response parser preserves
  unquoted int64 tokens as decimal strings before JavaScript can round them;
  exponent/fraction number tokens, duplicate keys, excessive nesting, and
  overlong integers fail closed.
- Each claimed page carries a persisted cursor, page number, and prior digest.
  A full 1,000-row page must commit a strictly advancing continuation; a
  repeated digest or non-advancing cursor fails the attempt without advancing
  the trusted watermark.
- The source-page commit atomically persists a constrained post-commit outbox
  effect. That private effect contains the exact discovered-symbol set and, for
  fills/income, a server-generated Ledger shadow projection with deterministic
  digests and `SHADOW/NOT_EVALUATED` reconciliation. A worker drains one leased
  effect before claiming another source page; retries cannot unlock a
  capability or self-report `PASS`/`PRIMARY`.
- `pg_cron` may call only `POST /internal/v1/sync/cron` with the dedicated
  `x-rv-worker-token` and the exact body `{"source":"pg_cron"}`. One request
  claims and processes at most one page; it cannot select a tenant or job.
- `pg_cron` may call only `POST /internal/v1/archive/cron` with the separate
  archive token and the same exact body. One invocation claims one
  database-selected persistent archive lease and performs one fixed USD-M GET step for
  fills/trades, orders, or income. Request windows are at most 365 days; the
  official monthly quotas are represented explicitly (trade/income 5, order
  10), poll responses are exact-schema checked, and completed links must expire
  within seven days. The link is sent only to a private service RPC and is
  omitted from HTTP receipts, state returned to callers, and error messages.
- Archive quota exhaustion, unsupported coverage, polling exhaustion, or an
  expired link moves the job to an explicit `CSV_REQUIRED` evidence path. The
  Edge client never downloads an archive URL and has no arbitrary-URL fetch.
- This function exposes no GitHub OIDC exchange and no caller-selected job-run
  route. Private Actions download and ingest flows use only the separately
  hardened `beta-operations` broker.
- Dataset, trade, and review reads use the caller JWT with narrow tenant-scoped
  RPCs. Destructive requests are forwarded to the existing recent-OTP deletion
  orchestrator; this function never performs a raw service-role delete.

## Honest boundaries

- This runtime does not provide a static outbound IP, so it cannot make Binance
  IP allowlisting available on Supabase Edge.
- A successful recent-page fetch does not prove complete history. It remains
  `PARTIAL`/`UNKNOWN` until archive or CSV coverage and reconciliation pass.
- Staging a Binance short-lived link is not proof that the file was downloaded,
  parsed, or complete. Private Actions still needs a real object digest and
  coverage receipt; until that broker/ingest evidence exists, the archive must
  not be marked covered or made claimable by the runner.
- The Project Secret holder and a privileged deployment administrator can
  decrypt server-readable Binance credentials; this is not zero knowledge.
- The Edge module does not itself publish Ledger generations, run monthly
  restores, configure SMTP, or prove two-user live isolation.

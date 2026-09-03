# Signed vault-head publisher

Deploy this function only with the production-vault baseline in a new,
dedicated Supabase project. Run the schema and Edge tests first:

```powershell
node --test tests/production-vault-schema.test.mjs tests/vault-publish-edge.test.mjs
```

Configure the exact browser Origin (no path or wildcard) and deploy with manual
gateway JWT handling:

```powershell
supabase secrets set APP_ORIGIN=https://binance-futures-review-web.vercel.app --project-ref <NEW_PROJECT_REF>
supabase functions deploy publish-vault-head --project-ref <NEW_PROJECT_REF> --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are server-managed. The service
role must never enter a `VITE_*` value, repository file, Pages setting, log, or
browser response. `verify_jwt=false` is intentional only because this function
does its own exact-Origin check and validates the bearer token through
`/auth/v1/user` before any service-role read or RPC. It also strictly binds the
verified subject to the JWT's UUID `session_id`; the CAS RPC rechecks that exact
subject/session pair against `auth.sessions` in the same transaction. A revoked
or missing session therefore fails closed even if revocation races the initial
Auth verification.

The request has exactly four fields:

```json
{"protocolVersion":"rv-vault-publish/1","workspaceId":"uuid","objectId":"uuid","expectedGeneration":0}
```

The function loads the verified subject's immutable `ed25519-v1` SPKI root,
candidate metadata, and current head through the single service-only
`rv_service_read_publish_context` RPC. It verifies the exact nine-line manifest
defined in `production-vault/README.md`, then invokes only
`rv_service_publish_vault_head`. The SQL boundary first locks the live Auth session,
then rechecks the generation and parent under a workspace-row lock, so a
revocation race cannot commit and two concurrent successors cannot both win.
The context call crosses the vault subject/session 120/minute buckets and the
ten-slot transaction semaphore. Bucket (`P0004`) and capacity (`P0005`)
rejections both produce a generic retryable `429` with `Retry-After: 1`.

## Honest boundaries

- The function authenticates an already uploaded candidate; it does not decrypt
  ciphertext or decide whether trading records are complete or correct.
- A lost success response is intentionally not made into a blind replay. The
  client must reload and verify the signed head/history before classifying the
  result.
- Ed25519 cannot protect a compromised browser, stolen recovery/signing secret,
  malicious extension, administrator with service-role access, or future
  configuration drift.
- `revoked_at` is not cryptographic key revocation. A copied signing private key
  remains effective until a separately reviewed root-rotation protocol exists.
- Session binding cannot undo a mutation that committed before revocation won
  its database lock; it guarantees transaction ordering, not retroactive undo.
- The database controls committed statement throughput and transaction
  concurrency; they are not trusted-IP, Edge invocation, or whole-project
  limits. A candidate-not-found statement rolls its token charge back, so a
  trusted gateway is still required for durable all-attempt/IP limiting.

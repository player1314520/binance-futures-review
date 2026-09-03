-- Restore v2: lineage-preserving, deletion-journal-aware disaster recovery.
--
-- This migration is additive. The legacy v1 restore plane remains NOT_READY;
-- a v1 manifest is recorded only as LEGACY_UNTRUSTED and can never publish.
-- R2 Standard is treated as private best-effort storage, not as WORM.

begin;

do $preflight$
begin
  if to_regclass('public.rv2_tenants') is null
     or to_regclass('private.rv2_credential_envelopes') is null
     or to_regprocedure('private.rv2_require_service_role()') is null then
    raise exception 'restore v2 requires the complete invite-beta rv2 migration'
      using errcode = 'P0001';
  end if;
end
$preflight$;

-- Restored connections retain historical records but never retain a Binance
-- credential. A fresh, verified connection rotation is mandatory.
alter table public.rv2_connections
  drop constraint rv2_connections_status_check;
alter table public.rv2_connections
  add constraint rv2_connections_status_check check (
    status in (
      'VERIFYING', 'ACTIVE', 'AUTH_ERROR', 'RATE_LIMITED', 'DISABLED',
      'REVOKED', 'RECONNECT_REQUIRED'
    )
  );

create table private.rv2_restore_v2_tenant_lineage (
  tenant_lineage_id uuid not null default gen_random_uuid(),
  source_tenant_id uuid not null,
  retired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_tenant_lineage_pkey primary key (tenant_lineage_id),
  constraint rv2_restore_v2_tenant_source_key unique (source_tenant_id)
);

create table private.rv2_restore_v2_principal_lineage (
  principal_lineage_id uuid not null default gen_random_uuid(),
  tenant_lineage_id uuid not null,
  source_user_id uuid not null,
  recovery_tag_hash text not null,
  member_role text not null,
  retired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_principal_lineage_pkey primary key (principal_lineage_id),
  constraint rv2_restore_v2_principal_source_key unique (source_user_id),
  constraint rv2_restore_v2_principal_tenant_fkey foreign key (tenant_lineage_id)
    references private.rv2_restore_v2_tenant_lineage (tenant_lineage_id),
  constraint rv2_restore_v2_principal_hash_check check (recovery_tag_hash ~ '^[0-9a-f]{64}$'),
  constraint rv2_restore_v2_principal_role_check check (member_role = 'OWNER')
);

create table private.rv2_restore_v2_connection_lineage (
  connection_lineage_id uuid not null default gen_random_uuid(),
  tenant_lineage_id uuid not null,
  source_connection_id uuid not null,
  retired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_connection_lineage_pkey primary key (connection_lineage_id),
  constraint rv2_restore_v2_connection_source_key unique (source_connection_id),
  constraint rv2_restore_v2_connection_tenant_fkey foreign key (tenant_lineage_id)
    references private.rv2_restore_v2_tenant_lineage (tenant_lineage_id)
);

create table private.rv2_restore_v2_deletion_intents (
  intent_id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  tenant_id uuid not null,
  tenant_lineage_id uuid not null,
  subject_id uuid not null,
  expected_membership_version bigint not null,
  operation text not null,
  event_sha256 text not null,
  state text not null default 'PENDING_JOURNAL',
  journaled_at timestamptz,
  deleted_at timestamptz,
  receipt_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_deletion_intents_pkey primary key (intent_id),
  constraint rv2_restore_v2_deletion_event_key unique (event_id),
  constraint rv2_restore_v2_deletion_lineage_fkey foreign key (tenant_lineage_id)
    references private.rv2_restore_v2_tenant_lineage (tenant_lineage_id),
  constraint rv2_restore_v2_deletion_version_check check (expected_membership_version > 0),
  constraint rv2_restore_v2_deletion_operation_check check (
    operation in ('DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT')
  ),
  constraint rv2_restore_v2_deletion_sha_check check (event_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_restore_v2_deletion_state_check check (
    (state = 'PENDING_JOURNAL' and journaled_at is null and deleted_at is null and receipt_id is null)
    or (state = 'JOURNALED' and journaled_at is not null and deleted_at is null and receipt_id is null)
    or (state = 'DELETED' and journaled_at is not null and deleted_at is not null and receipt_id is not null)
    or (state = 'QUARANTINED' and deleted_at is null and receipt_id is null)
  )
);

create index rv2_restore_v2_deletion_window_idx
  on private.rv2_restore_v2_deletion_intents (created_at, operation, tenant_id, subject_id);

create table private.rv2_restore_v2_deletion_evidence (
  intent_id uuid not null,
  object_key text not null,
  object_sha256 text not null,
  object_bytes bigint not null,
  if_none_match text not null,
  head_verified boolean not null,
  private_access_verified boolean not null,
  range_start timestamptz not null,
  range_end timestamptz not null,
  first_pass_root text not null,
  second_pass_root text not null,
  evidence_sha256 text not null,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_deletion_evidence_pkey primary key (intent_id),
  constraint rv2_restore_v2_deletion_evidence_intent_fkey foreign key (intent_id)
    references private.rv2_restore_v2_deletion_intents (intent_id) on delete cascade,
  constraint rv2_restore_v2_deletion_object_key_check check (
    object_key ~ '^deletion-journal/v2/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f-]{36}[.]json$'
    and object_key !~ '\.\.'
  ),
  constraint rv2_restore_v2_deletion_evidence_sha_check check (
    object_sha256 ~ '^[0-9a-f]{64}$'
    and first_pass_root ~ '^[0-9a-f]{64}$'
    and second_pass_root = first_pass_root
    and evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_restore_v2_deletion_evidence_object_check check (
    object_bytes > 0 and if_none_match = '*'
    and head_verified and private_access_verified
  ),
  constraint rv2_restore_v2_deletion_evidence_range_check check (range_start <= range_end)
);

create table private.rv2_restore_v2_snapshots (
  snapshot_id uuid not null,
  manifest jsonb not null,
  envelope_sha256 text not null,
  signature_verified boolean not null,
  manifest_trust text not null,
  ordered_content_root text not null,
  tenant_lineage_root text not null,
  plaintext_stream_sha256 text not null,
  external_journal_root text not null,
  row_count bigint not null,
  row_counts jsonb not null,
  created_at timestamptz not null,
  claimed_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_snapshots_pkey primary key (snapshot_id),
  constraint rv2_restore_v2_snapshot_sha_check check (
    envelope_sha256 ~ '^[0-9a-f]{64}$'
    and ordered_content_root ~ '^[0-9a-f]{64}$'
    and tenant_lineage_root ~ '^[0-9a-f]{64}$'
    and plaintext_stream_sha256 ~ '^[0-9a-f]{64}$'
    and external_journal_root ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_restore_v2_snapshot_trust_check check (
    manifest_trust in ('VERIFIED_V2', 'LEGACY_UNTRUSTED')
  ),
  constraint rv2_restore_v2_snapshot_signature_check check (
    (manifest_trust = 'VERIFIED_V2' and signature_verified)
    or (manifest_trust = 'LEGACY_UNTRUSTED' and not signature_verified)
  ),
  constraint rv2_restore_v2_snapshot_rows_check check (
    row_count > 0 and jsonb_typeof(row_counts) = 'object'
  )
);

create table private.rv2_restore_v2_runs (
  restore_id uuid not null default gen_random_uuid(),
  snapshot_id uuid not null,
  state text not null default 'STAGING',
  blocking_reasons text[] not null default array[]::text[],
  expected_batches integer,
  received_batches integer not null default 0,
  received_rows bigint not null default 0,
  graph_verified boolean not null default false,
  journal_proof_verified boolean not null default false,
  journal_range_start timestamptz,
  journal_range_end timestamptz,
  journal_first_pass_root text,
  journal_second_pass_root text,
  journal_events jsonb not null default '[]'::jsonb,
  effective_tenant_lineage_root text,
  journal_final_proof_sha256 text,
  journal_final_verified_at timestamptz,
  published_at timestamptz,
  credentials_restored integer not null default 0,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_runs_pkey primary key (restore_id),
  constraint rv2_restore_v2_runs_snapshot_key unique (snapshot_id),
  constraint rv2_restore_v2_runs_snapshot_fkey foreign key (snapshot_id)
    references private.rv2_restore_v2_snapshots (snapshot_id),
  constraint rv2_restore_v2_runs_state_check check (
    state in (
      'STAGING', 'NOT_READY', 'AWAITING_OWNER_CLAIMS', 'PUBLISHABLE',
      'PUBLISHED', 'QUARANTINED'
    )
  ),
  constraint rv2_restore_v2_runs_batch_check check (
    (expected_batches is null and received_batches = 0 and received_rows = 0)
    or (expected_batches between 1 and 100000
      and received_batches between 0 and expected_batches and received_rows >= 0)
  ),
  constraint rv2_restore_v2_runs_journal_check check (
    (not journal_proof_verified)
    or (journal_range_start is not null and journal_range_end is not null
      and journal_first_pass_root ~ '^[0-9a-f]{64}$'
      and journal_second_pass_root = journal_first_pass_root
      and jsonb_typeof(journal_events) = 'array')
  ),
  constraint rv2_restore_v2_runs_final_journal_check check (
    (journal_final_proof_sha256 is null and journal_final_verified_at is null)
    or (journal_final_proof_sha256 ~ '^[0-9a-f]{64}$'
      and journal_final_verified_at is not null)
  ),
  constraint rv2_restore_v2_runs_publish_check check (
    (state = 'PUBLISHED' and published_at is not null
      and journal_final_verified_at is not null and credentials_restored = 0)
    or (state <> 'PUBLISHED' and published_at is null and credentials_restored = 0)
  )
);

create table private.rv2_restore_v2_batches (
  restore_id uuid not null,
  batch_index integer not null,
  total_batches integer not null,
  idempotency_key uuid not null,
  batch_sha256 text not null,
  row_count integer not null,
  received_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_batches_pkey primary key (restore_id, batch_index),
  constraint rv2_restore_v2_batches_idempotency_key unique (restore_id, idempotency_key),
  constraint rv2_restore_v2_batches_restore_fkey foreign key (restore_id)
    references private.rv2_restore_v2_runs (restore_id) on delete cascade,
  constraint rv2_restore_v2_batches_index_check check (
    total_batches between 1 and 100000 and batch_index between 0 and total_batches - 1
  ),
  constraint rv2_restore_v2_batches_sha_check check (batch_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_restore_v2_batches_rows_check check (row_count between 0 and 250)
);

create table private.rv2_restore_v2_staging_rows (
  restore_id uuid not null,
  row_ordinal bigint not null,
  dataset text not null,
  record_id uuid not null,
  tenant_lineage_id uuid not null,
  connection_lineage_id uuid,
  principal_lineage_id uuid,
  payload jsonb not null,
  canonical_line text not null,
  row_sha256 text not null,
  suppressed_by_deletion boolean not null default false,
  batch_index integer not null,
  constraint rv2_restore_v2_staging_rows_pkey primary key (restore_id, row_ordinal),
  constraint rv2_restore_v2_staging_record_key unique (restore_id, dataset, record_id),
  constraint rv2_restore_v2_staging_batch_fkey foreign key (restore_id, batch_index)
    references private.rv2_restore_v2_batches (restore_id, batch_index) on delete cascade,
  constraint rv2_restore_v2_staging_dataset_check check (
    dataset in (
      'tenants', 'memberships', 'connections', 'source_events', 'generations',
      'trade_identities', 'trade_read_models', 'reviews', 'actions',
      'journal_entries', 'risk_rules', 'reports',
      'ledger_generations', 'reconciliation_generations'
    )
  ),
  constraint rv2_restore_v2_staging_line_check check (
    octet_length(canonical_line) between 2 and 1048576
    and row_sha256 ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(payload) = 'object'
  )
);

create table private.rv2_restore_v2_owner_claims (
  restore_id uuid not null,
  principal_lineage_id uuid not null,
  tenant_lineage_id uuid not null,
  recovery_tag_hash text not null,
  invite_claim_hash text,
  invite_delivery_id uuid,
  invite_nonce uuid,
  invite_generation integer not null default 0,
  state text not null default 'PENDING_INVITE',
  claimed_user_id uuid,
  invited_at timestamptz,
  invite_expires_at timestamptz,
  claimed_at timestamptz,
  constraint rv2_restore_v2_owner_claims_pkey primary key (restore_id, principal_lineage_id),
  constraint rv2_restore_v2_owner_claims_user_key unique (restore_id, claimed_user_id),
  constraint rv2_restore_v2_owner_claims_restore_fkey foreign key (restore_id)
    references private.rv2_restore_v2_runs (restore_id) on delete cascade,
  constraint rv2_restore_v2_owner_claims_hash_check check (
    recovery_tag_hash ~ '^[0-9a-f]{64}$'
    and (invite_claim_hash is null or invite_claim_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint rv2_restore_v2_owner_claims_state_check check (
    (state = 'PENDING_INVITE' and invite_claim_hash is null and invited_at is null
      and invite_delivery_id is null and invite_nonce is null and invite_generation = 0
      and invite_expires_at is null and claimed_user_id is null and claimed_at is null)
    or (state = 'INVITED' and invite_claim_hash is not null and invited_at is not null
      and invite_delivery_id is not null and invite_nonce is not null
      and invite_generation > 0 and invite_expires_at > invited_at
      and invite_expires_at <= invited_at + interval '10 minutes'
      and claimed_user_id is null and claimed_at is null)
    or (state = 'CLAIMED' and invite_claim_hash is not null and invited_at is not null
      and invite_delivery_id is not null and invite_nonce is not null
      and invite_generation > 0 and invite_expires_at > invited_at
      and invite_expires_at <= invited_at + interval '10 minutes'
      and claimed_user_id is not null and claimed_at is not null)
  )
);

create table private.rv2_restore_v2_tenant_maps (
  restore_id uuid not null,
  tenant_lineage_id uuid not null,
  target_tenant_id uuid not null default gen_random_uuid(),
  constraint rv2_restore_v2_tenant_maps_pkey primary key (restore_id, tenant_lineage_id),
  constraint rv2_restore_v2_tenant_maps_target_key unique (target_tenant_id),
  constraint rv2_restore_v2_tenant_maps_restore_fkey foreign key (restore_id)
    references private.rv2_restore_v2_runs (restore_id) on delete cascade
);

create table private.rv2_restore_v2_connection_maps (
  restore_id uuid not null,
  connection_lineage_id uuid not null,
  tenant_lineage_id uuid not null,
  target_connection_id uuid not null default gen_random_uuid(),
  constraint rv2_restore_v2_connection_maps_pkey primary key (restore_id, connection_lineage_id),
  constraint rv2_restore_v2_connection_maps_target_key unique (target_connection_id),
  constraint rv2_restore_v2_connection_maps_restore_fkey foreign key (restore_id)
    references private.rv2_restore_v2_runs (restore_id) on delete cascade
);

-- A GitHub runner never receives service_role. The beta-operations broker uses
-- the exact OIDC run binding and these narrow RPCs to materialize one immutable
-- lineage-safe export, page through it, and authorize one signed ciphertext.
create table private.rv2_restore_v2_backup_exports (
  export_id uuid not null default gen_random_uuid(),
  run_id text not null,
  run_attempt text not null,
  snapshot_created_at timestamptz not null default statement_timestamp(),
  status text not null default 'MATERIALIZING',
  row_count bigint not null default 0,
  row_counts jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default statement_timestamp() + interval '1 hour',
  signed_at timestamptz,
  constraint rv2_restore_v2_backup_exports_pkey primary key (export_id),
  constraint rv2_restore_v2_backup_exports_run_key unique (run_id, run_attempt),
  constraint rv2_restore_v2_backup_exports_run_check check (
    run_id ~ '^[1-9][0-9]{0,19}$' and run_attempt ~ '^[1-9][0-9]{0,9}$'
  ),
  constraint rv2_restore_v2_backup_exports_state_check check (
    status in ('MATERIALIZING', 'READY', 'SIGNED', 'EXPIRED')
  ),
  constraint rv2_restore_v2_backup_exports_rows_check check (
    row_count >= 0 and jsonb_typeof(row_counts) = 'object'
  ),
  constraint rv2_restore_v2_backup_exports_expiry_check check (
    expires_at > snapshot_created_at
  ),
  constraint rv2_restore_v2_backup_exports_signed_check check (
    (status <> 'SIGNED' and signed_at is null)
    or (status = 'SIGNED' and signed_at is not null)
  )
);

create table private.rv2_restore_v2_backup_export_rows (
  export_id uuid not null,
  row_ordinal bigint not null,
  row_data jsonb not null,
  row_sha256 text not null,
  constraint rv2_restore_v2_backup_export_rows_pkey primary key (export_id, row_ordinal),
  constraint rv2_restore_v2_backup_export_rows_export_fkey foreign key (export_id)
    references private.rv2_restore_v2_backup_exports (export_id) on delete cascade,
  constraint rv2_restore_v2_backup_export_rows_ordinal_check check (row_ordinal >= 0),
  constraint rv2_restore_v2_backup_export_rows_data_check check (
    jsonb_typeof(row_data) = 'object' and octet_length(row_data::text) <= 1048576
  ),
  constraint rv2_restore_v2_backup_export_rows_sha_check check (
    row_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table private.rv2_restore_v2_backup_page_evidence (
  export_id uuid not null,
  run_id text not null,
  run_attempt text not null,
  request_cursor bigint,
  request_cursor_key text not null,
  next_cursor bigint,
  row_count integer not null,
  page_sha256 text not null,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_backup_page_evidence_pkey primary key (
    export_id, request_cursor_key
  ),
  constraint rv2_restore_v2_backup_page_evidence_export_fkey foreign key (export_id)
    references private.rv2_restore_v2_backup_exports (export_id) on delete cascade,
  constraint rv2_restore_v2_backup_page_evidence_cursor_check check (
    request_cursor_key = coalesce(request_cursor::text, '__FIRST__')
    and (request_cursor is null or request_cursor >= 0)
    and (next_cursor is null or next_cursor > coalesce(request_cursor, -1))
  ),
  constraint rv2_restore_v2_backup_page_evidence_rows_check check (
    row_count between 0 and 250
  ),
  constraint rv2_restore_v2_backup_page_evidence_sha_check check (
    page_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table private.rv2_restore_v2_backup_signing_claims (
  claim_id uuid not null default gen_random_uuid(),
  export_id uuid not null,
  run_id text not null,
  run_attempt text not null,
  manifest_sha256 text not null,
  journal_proof_sha256 text not null,
  scope_prefix text not null,
  object_key text not null,
  object_bytes bigint not null,
  object_sha256 text not null,
  claimed_at timestamptz not null default statement_timestamp(),
  constraint rv2_restore_v2_backup_signing_claims_pkey primary key (claim_id),
  constraint rv2_restore_v2_backup_signing_claims_run_key unique (run_id, run_attempt),
  constraint rv2_restore_v2_backup_signing_claims_export_fkey foreign key (export_id)
    references private.rv2_restore_v2_backup_exports (export_id),
  constraint rv2_restore_v2_backup_signing_claims_sha_check check (
    manifest_sha256 ~ '^[0-9a-f]{64}$'
    and journal_proof_sha256 ~ '^[0-9a-f]{64}$'
    and object_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_restore_v2_backup_signing_claims_scope_check check (
    length(scope_prefix) between 8 and 512
    and object_key like scope_prefix || '%'
    and object_key !~ '(^|/)[.][.](/|$)'
  ),
  constraint rv2_restore_v2_backup_signing_claims_object_check check (
    object_bytes between 1 and 1099511627776
  )
);

create function private.rv2_restore_v2_pepper()
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_pepper text;
begin
  select s.decrypted_secret into v_pepper
    from vault.decrypted_secrets as s
   where s.name = 'rv2_restore_v2_recovery_pepper'
   limit 1;
  if v_pepper is null or octet_length(v_pepper) < 32 or octet_length(v_pepper) > 128 then
    raise exception 'restore recovery pepper unavailable' using errcode = 'P0001';
  end if;
  return v_pepper;
end
$function$;

create function private.rv2_restore_v2_recovery_tag(
  p_email text,
  p_principal_lineage_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if p_email is null or length(p_email) not between 3 and 320
     or p_principal_lineage_id is null then
    raise exception 'verified recovery identity unavailable' using errcode = 'P0002';
  end if;
  return encode(extensions.hmac(
    convert_to(
      'rv-restore-v2-recovery/1' || chr(0)
      || p_principal_lineage_id::text || chr(0) || lower(p_email),
      'utf8'
    ),
    convert_to(private.rv2_restore_v2_pepper(), 'utf8'),
    'sha256'
  ), 'hex');
end
$function$;

create function private.rv2_restore_v2_project_is_empty()
returns boolean
language sql
security definer
set search_path = pg_catalog
as $function$
  select not exists (select 1 from public.rv2_tenants)
     and not exists (select 1 from public.rv2_memberships)
     and not exists (select 1 from public.rv2_connections)
     and not exists (select 1 from private.rv2_credential_envelopes)
$function$;

create function private.rv2_restore_v2_uuid_from_text(p_value text)
returns uuid
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_hex text;
begin
  v_hex := encode(extensions.digest(convert_to(
    'rv-restore-v2-record-id/1' || chr(0) || p_value, 'utf8'
  ), 'sha256'), 'hex');
  return (
    substring(v_hex, 1, 8) || '-' || substring(v_hex, 9, 4) || '-5'
    || substring(v_hex, 14, 3) || '-a' || substring(v_hex, 18, 3)
    || '-' || substring(v_hex, 21, 12)
  )::uuid;
end
$function$;

-- The journal object SHA is the SHA-256 of the exact UTF-8 object bytes that
-- the R2 writer persists: RFC-8259 JSON with lexicographically ordered keys,
-- no insignificant whitespace, and one trailing LF. Do not hash jsonb::text:
-- PostgreSQL's display representation contains spaces and omits the object LF,
-- so it is a semantic hash rather than the immutable R2 object digest.
create function private.rv2_restore_v2_deletion_event_object_text(p_event jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
begin
  if jsonb_typeof(p_event) <> 'object'
     or (select count(*) from jsonb_object_keys(p_event)) <> 5
     or not (p_event ?& array[
       'committedAt', 'eventId', 'format', 'operation', 'tenantLineageId'
     ])
     or coalesce(p_event ->> 'format', '') <> 'rv-deletion-journal-event/2'
     or coalesce(p_event ->> 'eventId', '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_event ->> 'tenantLineageId', '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_event ->> 'operation', '')
       not in ('DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT')
     or (p_event ->> 'committedAt') is null then
    raise exception 'deletion journal object invalid' using errcode = '22023';
  end if;
  return '{"committedAt":' || to_jsonb(p_event ->> 'committedAt')::text
    || ',"eventId":' || to_jsonb(p_event ->> 'eventId')::text
    || ',"format":' || to_jsonb(p_event ->> 'format')::text
    || ',"operation":' || to_jsonb(p_event ->> 'operation')::text
    || ',"tenantLineageId":' || to_jsonb(p_event ->> 'tenantLineageId')::text
    || '}' || chr(10);
end
$function$;

-- A caller-provided journal proof is accepted only inside a short, realistic
-- freshness window.  Requiring rangeEnd to be in the future is impossible for
-- an honest client after LIST/HEAD/GET and network transit.  Both claim and
-- publish call this helper; publish additionally supplies the claim proof's
-- rangeEnd so a replay cannot move the proven deletion horizon backwards.
create function private.rv2_restore_v2_journal_proof_is_valid(
  p_proof jsonb,
  p_snapshot_created_at timestamptz,
  p_expected_snapshot_root text,
  p_minimum_range_end timestamptz default null
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $function$
declare
  v_key_count integer;
  v_object_count integer;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if jsonb_typeof(p_proof) <> 'object' then return false; end if;
  select count(*) into v_key_count from jsonb_object_keys(p_proof);
  if v_key_count <> 10
     or not (p_proof ?& array[
       'format', 'rangeStart', 'rangeEnd', 'firstPassRoot', 'secondPassRoot',
       'objectCount', 'events', 'storageClaim', 'snapshotJournalRoot',
       'effectiveTenantLineageRoot'
     ])
     or p_proof ->> 'format' <> 'rv-deletion-journal-range-proof/2'
     or p_proof ->> 'firstPassRoot' !~ '^[0-9a-f]{64}$'
     or p_proof ->> 'secondPassRoot' <> p_proof ->> 'firstPassRoot'
     or p_proof ->> 'snapshotJournalRoot' <> p_expected_snapshot_root
     or p_proof ->> 'effectiveTenantLineageRoot' !~ '^[0-9a-f]{64}$'
     or p_proof ->> 'storageClaim'
       <> 'private-r2-best-effort-append-only-not-worm'
     or p_proof ->> 'objectCount' !~ '^(0|[1-9][0-9]{0,3})$'
     or jsonb_typeof(p_proof -> 'events') <> 'array' then
    return false;
  end if;
  v_object_count := (p_proof ->> 'objectCount')::integer;
  if v_object_count > 4096
     or jsonb_array_length(p_proof -> 'events') <> v_object_count then
    return false;
  end if;
  begin
    v_range_start := (p_proof ->> 'rangeStart')::timestamptz;
    v_range_end := (p_proof ->> 'rangeEnd')::timestamptz;
  exception when others then
    return false;
  end;
  if p_proof ->> 'rangeStart'
       !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     or p_proof ->> 'rangeEnd'
       !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     or v_range_start <> (
       (date_trunc('day', p_snapshot_created_at at time zone 'UTC')
         - interval '1 day') at time zone 'UTC'
     )
     or v_range_start > p_snapshot_created_at
     or v_range_end < p_snapshot_created_at
     or v_range_end < v_range_start
     or v_range_end < statement_timestamp() - interval '5 minutes'
     or v_range_end > statement_timestamp() + interval '5 minutes'
     or (p_minimum_range_end is not null and v_range_end < p_minimum_range_end) then
    return false;
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_proof -> 'events') as e(value)
     where jsonb_typeof(e.value) <> 'object'
        or (select count(*) from jsonb_object_keys(e.value)) <> 4
        or not (e.value ?& array[
          'committedAt', 'eventId', 'operation', 'tenantLineageId'
        ])
        or coalesce(e.value ->> 'eventId', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(e.value ->> 'tenantLineageId', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(e.value ->> 'operation', '')
          not in ('DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT')
        or coalesce(e.value ->> 'committedAt', '')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  ) or exists (
    select 1
      from jsonb_array_elements(p_proof -> 'events') as e(value)
     where (e.value ->> 'committedAt')::timestamptz < v_range_start
        or (e.value ->> 'committedAt')::timestamptz > v_range_end
  ) or exists (
    select 1
      from jsonb_array_elements(p_proof -> 'events') as e(value)
     group by e.value ->> 'eventId'
    having count(*) <> 1
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end
$function$;

create function public.rv2_restore_v2_prepare_lineage()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_member record;
  v_connection record;
  v_tenant_lineage_id uuid;
  v_principal_lineage_id uuid;
  v_tag text;
  v_tenants bigint;
  v_principals bigint;
  v_connections bigint;
begin
  perform private.rv2_require_service_role();
  insert into private.rv2_restore_v2_tenant_lineage (source_tenant_id)
  select t.tenant_id from public.rv2_tenants as t
  on conflict (source_tenant_id) do nothing;

  for v_member in
    select m.*, u.email, u.email_confirmed_at
      from public.rv2_memberships as m
      join auth.users as u on u.id = m.user_id
     where m.status = 'ACTIVE'
     order by m.tenant_id, m.user_id
  loop
    if v_member.email is null or v_member.email_confirmed_at is null then
      raise exception 'server-verified email recovery tag unavailable'
        using errcode = 'P0002';
    end if;
    select t.tenant_lineage_id into v_tenant_lineage_id
      from private.rv2_restore_v2_tenant_lineage as t
     where t.source_tenant_id = v_member.tenant_id;
    select p.principal_lineage_id into v_principal_lineage_id
      from private.rv2_restore_v2_principal_lineage as p
     where p.source_user_id = v_member.user_id;
    if v_principal_lineage_id is null then
      v_principal_lineage_id := gen_random_uuid();
    end if;
    v_tag := private.rv2_restore_v2_recovery_tag(
      v_member.email,
      v_principal_lineage_id
    );
    insert into private.rv2_restore_v2_principal_lineage (
      principal_lineage_id, tenant_lineage_id, source_user_id,
      recovery_tag_hash, member_role
    ) values (
      v_principal_lineage_id, v_tenant_lineage_id, v_member.user_id,
      encode(extensions.digest(convert_to(v_tag, 'utf8'), 'sha256'), 'hex'),
      v_member.member_role
    )
    on conflict (source_user_id) do update
      set tenant_lineage_id = excluded.tenant_lineage_id,
          recovery_tag_hash = excluded.recovery_tag_hash,
          member_role = excluded.member_role,
          retired_at = null;
  end loop;

  for v_connection in
    select c.tenant_id, c.connection_id
      from public.rv2_connections as c
     order by c.tenant_id, c.connection_id
  loop
    select t.tenant_lineage_id into v_tenant_lineage_id
      from private.rv2_restore_v2_tenant_lineage as t
     where t.source_tenant_id = v_connection.tenant_id;
    insert into private.rv2_restore_v2_connection_lineage (
      tenant_lineage_id, source_connection_id
    ) values (v_tenant_lineage_id, v_connection.connection_id)
    on conflict (source_connection_id) do update
      set tenant_lineage_id = excluded.tenant_lineage_id,
          retired_at = null;
  end loop;

  select count(*) into v_tenants from private.rv2_restore_v2_tenant_lineage;
  select count(*) into v_principals from private.rv2_restore_v2_principal_lineage;
  select count(*) into v_connections from private.rv2_restore_v2_connection_lineage;
  return jsonb_build_object(
    'format', 'rv-restore-v2-lineage-prepared/1',
    'tenantLineages', v_tenants,
    'principalLineages', v_principals,
    'connectionLineages', v_connections,
    'credentialsIncluded', false
  );
end
$function$;

create function public.rv2_restore_v2_verified_recovery_tag(p_subject uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_member record;
  v_principal record;
  v_tag text;
begin
  perform private.rv2_require_service_role();
  if p_subject is null then
    raise exception 'verified recovery identity unavailable' using errcode = 'P0002';
  end if;
  perform public.rv2_restore_v2_prepare_lineage();
  select m.tenant_id, m.member_role, u.email, u.email_confirmed_at
    into v_member
    from public.rv2_memberships as m
    join auth.users as u on u.id = m.user_id
   where m.user_id = p_subject and m.status = 'ACTIVE';
  if not found or v_member.email is null or v_member.email_confirmed_at is null then
    raise exception 'server-verified email recovery tag unavailable'
      using errcode = 'P0002';
  end if;
  select p.* into v_principal
    from private.rv2_restore_v2_principal_lineage as p
   where p.source_user_id = p_subject;
  if not found then
    raise exception 'verified recovery identity unavailable' using errcode = 'P0002';
  end if;
  v_tag := private.rv2_restore_v2_recovery_tag(
    v_member.email,
    v_principal.principal_lineage_id
  );
  return jsonb_build_object(
    'format', 'rv-restore-v2-recovery-tag/1',
    'subject', p_subject,
    'principalLineageId', v_principal.principal_lineage_id,
    'tenantLineageId', v_principal.tenant_lineage_id,
    'recoveryTag', v_tag,
    'recoveryTagSha256', encode(
      extensions.digest(convert_to(v_tag, 'utf8'), 'sha256'), 'hex'
    ),
    'emailSource', 'AUTH_VERIFIED_SERVER_SIDE'
  );
end
$function$;

create function public.rv2_restore_v2_create_deletion_intent(
  p_subject uuid,
  p_tenant_id uuid,
  p_expected_membership_version bigint,
  p_operation text,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_member record;
  v_lineage uuid;
  v_event jsonb;
  v_event_sha256 text;
  v_intent record;
  v_recent_count bigint;
begin
  perform private.rv2_require_service_role();
  if p_subject is null or p_tenant_id is null or p_event_id is null
     or coalesce(p_expected_membership_version, 0) <= 0
     or p_operation not in ('DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT') then
    raise exception 'deletion intent rejected' using errcode = '22023';
  end if;

  -- A retry of the same receipt must not consume journal budget or acquire a
  -- new timestamp.  Reconstruct the exact original JSON-plus-LF semantic
  -- object from the persisted row and reject any changed binding.
  select i.* into v_intent
    from private.rv2_restore_v2_deletion_intents as i
   where i.event_id = p_event_id
   for update;
  if found then
    if v_intent.tenant_id <> p_tenant_id
       or v_intent.subject_id <> p_subject
       or v_intent.operation <> p_operation
       or v_intent.expected_membership_version <> p_expected_membership_version then
      raise exception 'deletion intent idempotency conflict' using errcode = '40001';
    end if;
    v_event := jsonb_build_object(
      'format', 'rv-deletion-journal-event/2',
      'eventId', v_intent.event_id,
      'tenantLineageId', v_intent.tenant_lineage_id,
      'operation', v_intent.operation,
      'committedAt', to_char(v_intent.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    if encode(extensions.digest(convert_to(
      private.rv2_restore_v2_deletion_event_object_text(v_event), 'utf8'
    ), 'sha256'), 'hex') <> v_intent.event_sha256 then
      raise exception 'deletion intent evidence conflict' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'format', 'rv-deletion-intent/2',
      'intentId', v_intent.intent_id,
      'event', v_event,
      'eventSha256', v_intent.event_sha256,
      'state', v_intent.state,
      'journalRequired', v_intent.state = 'PENDING_JOURNAL'
    );
  end if;

  -- The R2 proof reads only the deterministic recovery window beginning one
  -- UTC day before the snapshot.  Backups live for at most 30 days, so every
  -- restore window is contained in 32 days.  Serialize new intents globally:
  -- 4,086 entries stop CLEAR and new membership admission, reserving ten
  -- final DELETE_ACCOUNT events for the at-most-ten active Beta accounts.
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-deletion-journal-32d-budget', 0
  ));
  select count(*) into v_recent_count
    from private.rv2_restore_v2_deletion_intents as i
   where i.created_at >= statement_timestamp() - interval '32 days';
  if v_recent_count >= 4096
     or (p_operation = 'DELETE_BUSINESS_DATA' and v_recent_count >= 4086) then
    raise exception 'deletion journal window capacity exceeded' using errcode = 'P0004';
  end if;
  if p_operation = 'DELETE_BUSINESS_DATA' and exists (
    select 1 from private.rv2_restore_v2_deletion_intents as i
     where i.tenant_id = p_tenant_id
       and i.operation = 'DELETE_BUSINESS_DATA'
       and i.created_at >= statement_timestamp() - interval '24 hours'
  ) then
    raise exception 'deletion journal tenant rate exceeded' using errcode = 'P0004';
  end if;
  if p_operation = 'DELETE_ACCOUNT' and exists (
    select 1 from private.rv2_restore_v2_deletion_intents as i
     where i.tenant_id = p_tenant_id and i.subject_id = p_subject
       and i.operation = 'DELETE_ACCOUNT'
       and i.created_at >= statement_timestamp() - interval '32 days'
  ) then
    raise exception 'deletion journal account replay rejected' using errcode = 'P0004';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'rv2-restore-v2-deletion:' || p_tenant_id::text, 0
  ));
  select m.* into v_member
    from public.rv2_memberships as m
   where m.tenant_id = p_tenant_id and m.user_id = p_subject
     and m.status = 'ACTIVE'
   for update;
  if not found or v_member.member_role <> 'OWNER'
     or v_member.membership_version <> p_expected_membership_version then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform public.rv2_restore_v2_prepare_lineage();
  select t.tenant_lineage_id into v_lineage
    from private.rv2_restore_v2_tenant_lineage as t
   where t.source_tenant_id = p_tenant_id;
  v_event := jsonb_build_object(
    'format', 'rv-deletion-journal-event/2',
    'eventId', p_event_id,
    'tenantLineageId', v_lineage,
    'operation', p_operation,
    'committedAt', to_char(statement_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_event_sha256 := encode(extensions.digest(convert_to(
    private.rv2_restore_v2_deletion_event_object_text(v_event), 'utf8'
  ), 'sha256'), 'hex');
  insert into private.rv2_restore_v2_deletion_intents (
    event_id, tenant_id, tenant_lineage_id, subject_id,
    expected_membership_version, operation, event_sha256
  ) values (
    p_event_id, p_tenant_id, v_lineage, p_subject,
    p_expected_membership_version, p_operation, v_event_sha256
  )
  on conflict (event_id) do nothing;
  select i.* into v_intent
    from private.rv2_restore_v2_deletion_intents as i
   where i.event_id = p_event_id;
  if v_intent.tenant_id <> p_tenant_id or v_intent.subject_id <> p_subject
     or v_intent.operation <> p_operation
     or v_intent.expected_membership_version <> p_expected_membership_version
     or v_intent.event_sha256 <> v_event_sha256 then
    raise exception 'deletion intent idempotency conflict' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'format', 'rv-deletion-intent/2',
    'intentId', v_intent.intent_id,
    'event', v_event,
    'eventSha256', v_intent.event_sha256,
    'state', v_intent.state,
    'journalRequired', v_intent.state = 'PENDING_JOURNAL'
  );
end
$function$;

-- The reviewed public deletion controller already owns recent-session,
-- capability and anti-enumeration checks. This service-only adapter derives
-- tenant/version server-side and replays an existing intent even after the
-- membership has been deleted, so a lost Edge response never creates a new
-- journal event or bypasses the original receipt.
create function public.rv2_restore_v2_prepare_public_deletion(
  p_subject uuid,
  p_event_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_existing record;
  v_member record;
  v_event jsonb;
begin
  perform private.rv2_require_service_role();
  if p_subject is null or p_event_id is null
     or p_operation not in ('DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT') then
    raise exception 'deletion intent rejected' using errcode = '22023';
  end if;
  select i.* into v_existing
    from private.rv2_restore_v2_deletion_intents as i
   where i.event_id = p_event_id
   for update;
  if found then
    if v_existing.subject_id <> p_subject
       or v_existing.operation <> p_operation then
      raise exception 'deletion intent idempotency conflict' using errcode = '40001';
    end if;
    v_event := jsonb_build_object(
      'format', 'rv-deletion-journal-event/2',
      'eventId', v_existing.event_id,
      'tenantLineageId', v_existing.tenant_lineage_id,
      'operation', v_existing.operation,
      'committedAt', to_char(v_existing.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    if encode(extensions.digest(convert_to(
      private.rv2_restore_v2_deletion_event_object_text(v_event), 'utf8'
    ), 'sha256'), 'hex') <> v_existing.event_sha256 then
      raise exception 'deletion intent evidence conflict' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'format', 'rv-deletion-intent/2',
      'intentId', v_existing.intent_id,
      'event', v_event,
      'eventSha256', v_existing.event_sha256,
      'state', v_existing.state,
      'journalRequired', v_existing.state = 'PENDING_JOURNAL'
    );
  end if;

  select m.* into v_member
    from public.rv2_memberships as m
   where m.user_id = p_subject and m.status = 'ACTIVE'
   for update;
  if not found or v_member.member_role <> 'OWNER' then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  return public.rv2_restore_v2_create_deletion_intent(
    p_subject,
    v_member.tenant_id,
    v_member.membership_version,
    p_operation,
    p_event_id
  );
end
$function$;

create function public.rv2_restore_v2_attest_deletion_journal(
  p_intent_id uuid,
  p_object_evidence jsonb,
  p_range_proof jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_intent record;
  v_evidence_sha text;
  v_expected_root text;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  perform private.rv2_require_service_role();
  select i.* into v_intent
    from private.rv2_restore_v2_deletion_intents as i
   where i.intent_id = p_intent_id
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_intent.state = 'DELETED' or v_intent.state = 'JOURNALED' then
    return jsonb_build_object(
      'format', 'rv-deletion-journal-attestation/2',
      'intentId', p_intent_id, 'state', v_intent.state, 'idempotent', true
    );
  end if;
  if v_intent.state <> 'PENDING_JOURNAL'
     or jsonb_typeof(p_object_evidence) <> 'object'
     or jsonb_typeof(p_range_proof) <> 'object'
     or p_object_evidence ->> 'format' <> 'rv-r2-append-evidence/2'
     or p_object_evidence ->> 'ifNoneMatch' <> '*'
     or coalesce((p_object_evidence ->> 'headVerified')::boolean, false) is not true
     or coalesce((p_object_evidence ->> 'privateAccessVerified')::boolean, false) is not true
     or (p_object_evidence ->> 'objectSha256') <> v_intent.event_sha256
     or (p_object_evidence ->> 'objectBytes') !~ '^[1-9][0-9]{0,18}$'
     or (p_object_evidence ->> 'objectKey')
       <> 'deletion-journal/v2/'
          || to_char(v_intent.created_at at time zone 'UTC', 'YYYY/MM/DD/')
          || v_intent.event_id::text || '.json'
     or p_range_proof ->> 'format' <> 'rv-deletion-journal-range-proof/2'
     or (p_range_proof ->> 'firstPassRoot') !~ '^[0-9a-f]{64}$'
     or p_range_proof ->> 'secondPassRoot' <> p_range_proof ->> 'firstPassRoot'
     or p_range_proof ->> 'snapshotJournalRoot' <> p_range_proof ->> 'firstPassRoot'
     or p_range_proof ->> 'objectCount' <> '1'
     or p_range_proof ->> 'storageClaim'
       <> 'private-r2-best-effort-append-only-not-worm' then
    raise exception 'DELETION_JOURNAL_REQUIRED' using errcode = '22023';
  end if;
  v_expected_root := encode(extensions.digest(convert_to(
    'rv-deletion-journal-list/2' || chr(0)
    || (p_object_evidence ->> 'objectKey') || chr(0)
    || (p_object_evidence ->> 'objectSha256') || chr(0)
    || (p_object_evidence ->> 'objectBytes') || chr(10),
    'utf8'
  ), 'sha256'), 'hex');
  if p_range_proof ->> 'firstPassRoot' <> v_expected_root then
    raise exception 'DELETION_JOURNAL_REQUIRED' using errcode = '22023';
  end if;
  begin
    v_range_start := (p_range_proof ->> 'rangeStart')::timestamptz;
    v_range_end := (p_range_proof ->> 'rangeEnd')::timestamptz;
  exception when others then
    raise exception 'DELETION_JOURNAL_REQUIRED' using errcode = '22023';
  end;
  if v_range_start > v_intent.created_at
     or v_range_end < v_intent.created_at
     or v_range_end < statement_timestamp() - interval '5 minutes'
     or v_range_end > statement_timestamp() + interval '5 minutes'
     or v_range_end < v_range_start
     or jsonb_typeof(p_range_proof -> 'events') <> 'array'
     or jsonb_array_length(p_range_proof -> 'events') <> 1
     or not exists (
       select 1 from jsonb_array_elements(p_range_proof -> 'events') as event(value)
        where event.value ->> 'eventId' = v_intent.event_id::text
          and event.value ->> 'tenantLineageId' = v_intent.tenant_lineage_id::text
          and event.value ->> 'operation' = v_intent.operation
          and event.value ->> 'committedAt' = to_char(
            v_intent.created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
     ) then
    raise exception 'DELETION_JOURNAL_REQUIRED' using errcode = '22023';
  end if;
  v_evidence_sha := encode(extensions.digest(convert_to(jsonb_build_object(
    'intentId', p_intent_id,
    'eventSha256', v_intent.event_sha256,
    'objectEvidence', p_object_evidence,
    'rangeProof', p_range_proof
  )::text, 'utf8'), 'sha256'), 'hex');
  insert into private.rv2_restore_v2_deletion_evidence (
    intent_id, object_key, object_sha256, object_bytes, if_none_match,
    head_verified, private_access_verified, range_start, range_end,
    first_pass_root, second_pass_root, evidence_sha256
  ) values (
    p_intent_id, p_object_evidence ->> 'objectKey',
    p_object_evidence ->> 'objectSha256',
    (p_object_evidence ->> 'objectBytes')::bigint,
    p_object_evidence ->> 'ifNoneMatch',
    (p_object_evidence ->> 'headVerified')::boolean,
    (p_object_evidence ->> 'privateAccessVerified')::boolean,
    v_range_start, v_range_end,
    p_range_proof ->> 'firstPassRoot', p_range_proof ->> 'secondPassRoot',
    v_evidence_sha
  );
  update private.rv2_restore_v2_deletion_intents as i
     set state = 'JOURNALED', journaled_at = statement_timestamp(),
         updated_at = statement_timestamp()
   where i.intent_id = p_intent_id and i.state = 'PENDING_JOURNAL';
  return jsonb_build_object(
    'format', 'rv-deletion-journal-attestation/2',
    'intentId', p_intent_id, 'state', 'JOURNALED',
    'evidenceSha256', v_evidence_sha, 'idempotent', false
  );
end
$function$;

create function public.rv2_restore_v2_execute_deletion(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_intent record;
  v_result record;
  v_receipt uuid;
  v_deleted_at timestamptz;
begin
  perform private.rv2_require_service_role();
  select i.* into v_intent
    from private.rv2_restore_v2_deletion_intents as i
   where i.intent_id = p_intent_id
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_intent.state = 'DELETED' then
    return jsonb_build_object(
      'format', 'rv-deletion-result/2', 'intentId', p_intent_id,
      'state', 'DELETED', 'receiptId', v_intent.receipt_id,
      'deletedAt', v_intent.deleted_at, 'idempotent', true
    );
  end if;
  if v_intent.state <> 'JOURNALED' or not exists (
    select 1 from private.rv2_restore_v2_deletion_evidence as e
     where e.intent_id = p_intent_id and e.head_verified
       and e.private_access_verified and e.first_pass_root = e.second_pass_root
  ) then
    raise exception 'DELETION_JOURNAL_REQUIRED' using errcode = '55000';
  end if;
  -- Bind the maintenance-mode membership transition to this exact, locked
  -- JOURNALED intent. The setting is transaction-local and is cleared as soon
  -- as the controlled delete helper returns.
  perform set_config(
    'review_workbench.rv2_journal_delete_intent',
    v_intent.intent_id::text,
    true
  );
  select d.receipt_id, d.deleted_at into v_receipt, v_deleted_at
    from private.rv2_clear_subject_business_data(
      v_intent.subject_id,
      case v_intent.operation
        when 'DELETE_ACCOUNT' then 'DELETE_ACCOUNT'
        else 'CLEAR_BUSINESS_DATA'
      end,
      v_intent.event_id
    ) as d;
  perform set_config('review_workbench.rv2_journal_delete_intent', '', true);
  if v_receipt is null or v_deleted_at is null then
    raise exception 'business deletion failed' using errcode = 'P0001';
  end if;
  update private.rv2_restore_v2_deletion_intents as i
     set state = 'DELETED', receipt_id = v_receipt, deleted_at = v_deleted_at,
         updated_at = statement_timestamp()
   where i.intent_id = p_intent_id and i.state = 'JOURNALED';
  update private.rv2_restore_v2_tenant_lineage as t
     set retired_at = v_deleted_at
   where t.tenant_lineage_id = v_intent.tenant_lineage_id
     and v_intent.operation = 'DELETE_ACCOUNT';
  return jsonb_build_object(
    'format', 'rv-deletion-result/2', 'intentId', p_intent_id,
    'state', 'DELETED', 'receiptId', v_receipt,
    'deletedAt', v_deleted_at, 'idempotent', false,
    'journalAppliedBeforeDeletion', true
  );
end
$function$;

create function public.rv2_restore_v2_claim_restore(
  p_manifest jsonb,
  p_envelope_sha256 text,
  p_signature_verified boolean,
  p_journal_proof jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_snapshot_id uuid;
  v_snapshot_created_at timestamptz;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_run record;
  v_project_empty boolean;
  v_blocking text[] := array[]::text[];
  v_manifest_keys integer;
begin
  perform private.rv2_require_service_role();
  if jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'manifest rejected' using errcode = '22023';
  end if;
  if p_manifest ->> 'format' in (
    'review-workbench-beta-backup/1',
    'review-workbench-beta-signed-manifest/1'
  ) then
    return jsonb_build_object(
      'format', 'rv-restore-v2-claim-result/1',
      'state', 'QUARANTINED', 'published', false,
      'code', 'LEGACY_UNTRUSTED',
      'blockingReasons', jsonb_build_array('LEGACY_UNTRUSTED')
    );
  end if;
  select count(*) into v_manifest_keys from jsonb_object_keys(p_manifest);
  if p_manifest ->> 'format' <> 'rv-restore-snapshot-manifest/2'
     or v_manifest_keys <> 10
     or not (p_manifest ?& array[
       'format', 'snapshotId', 'createdAt', 'rowCount', 'rowCounts',
       'orderedContentRoot', 'tenantLineageRoot', 'plaintextStreamSha256',
       'externalJournalRoot', 'credentialsIncluded'
     ])
     or p_signature_verified is not true
     or p_envelope_sha256 !~ '^[0-9a-f]{64}$'
     or p_manifest ->> 'orderedContentRoot' !~ '^[0-9a-f]{64}$'
     or p_manifest ->> 'tenantLineageRoot' !~ '^[0-9a-f]{64}$'
     or p_manifest ->> 'plaintextStreamSha256' !~ '^[0-9a-f]{64}$'
     or p_manifest ->> 'externalJournalRoot' !~ '^[0-9a-f]{64}$'
     or p_manifest -> 'credentialsIncluded' <> 'false'::jsonb
     or p_manifest ->> 'rowCount' !~ '^[1-9][0-9]{0,12}$'
     or jsonb_typeof(p_manifest -> 'rowCounts') <> 'object' then
    raise exception 'manifest rejected' using errcode = '22023';
  end if;
  begin
    v_snapshot_id := (p_manifest ->> 'snapshotId')::uuid;
    v_snapshot_created_at := (p_manifest ->> 'createdAt')::timestamptz;
  exception when others then
    raise exception 'manifest rejected' using errcode = '22023';
  end;
  if v_snapshot_created_at > statement_timestamp() + interval '5 minutes' then
    raise exception 'manifest rejected' using errcode = '22023';
  end if;
  -- Serialize against deletion-intent creation while the target-empty and
  -- local intent coverage checks are evaluated.  A source project can be a
  -- different Supabase project, so the external proof remains mandatory.
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-deletion-journal-32d-budget', 0
  ));
  if not private.rv2_restore_v2_journal_proof_is_valid(
    p_journal_proof,
    v_snapshot_created_at,
    p_manifest ->> 'externalJournalRoot',
    null
  ) then
    v_blocking := array_append(v_blocking, 'EXTERNAL_JOURNAL_PROOF_MISSING');
  else
    v_range_start := (p_journal_proof ->> 'rangeStart')::timestamptz;
    v_range_end := (p_journal_proof ->> 'rangeEnd')::timestamptz;
    -- On an in-place recovery, an intent committed after or omitted from the
    -- proof is direct evidence that the remote range is stale.  Disaster
    -- recovery into a new project still relies on the final R2 re-proof.
    if exists (
      select 1
        from private.rv2_restore_v2_deletion_intents as i
       where i.created_at >= v_snapshot_created_at
         and (i.created_at > v_range_end or not exists (
           select 1
             from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
            where e.value ->> 'eventId' = i.event_id::text
              and e.value ->> 'tenantLineageId' = i.tenant_lineage_id::text
              and e.value ->> 'operation' = i.operation
              and e.value ->> 'committedAt' = to_char(
                i.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
         ))
    ) then
      v_blocking := array_append(v_blocking, 'EXTERNAL_JOURNAL_PROOF_MISSING');
    end if;
  end if;

  v_project_empty := private.rv2_restore_v2_project_is_empty();
  if not v_project_empty then
    v_blocking := array_append(v_blocking, 'TARGET_PROJECT_NOT_EMPTY');
  end if;

  insert into private.rv2_restore_v2_snapshots (
    snapshot_id, manifest, envelope_sha256, signature_verified, manifest_trust,
    ordered_content_root, tenant_lineage_root, plaintext_stream_sha256,
    external_journal_root, row_count, row_counts, created_at
  ) values (
    v_snapshot_id, p_manifest, p_envelope_sha256, true, 'VERIFIED_V2',
    p_manifest ->> 'orderedContentRoot', p_manifest ->> 'tenantLineageRoot',
    p_manifest ->> 'plaintextStreamSha256', p_manifest ->> 'externalJournalRoot',
    (p_manifest ->> 'rowCount')::bigint, p_manifest -> 'rowCounts',
    v_snapshot_created_at
  ) on conflict (snapshot_id) do nothing;
  if not exists (
    select 1 from private.rv2_restore_v2_snapshots as s
     where s.snapshot_id = v_snapshot_id
       and s.envelope_sha256 = p_envelope_sha256
       and s.manifest = p_manifest
  ) then
    raise exception 'snapshot replay conflict' using errcode = '40001';
  end if;
  insert into private.rv2_restore_v2_runs (
    snapshot_id, state, blocking_reasons, journal_proof_verified,
    journal_range_start, journal_range_end, journal_first_pass_root,
    journal_second_pass_root, journal_events, effective_tenant_lineage_root
  ) values (
    v_snapshot_id,
    case when cardinality(v_blocking) = 0 then 'STAGING' else 'QUARANTINED' end,
    v_blocking,
    cardinality(v_blocking) = 0,
    v_range_start, v_range_end,
    p_journal_proof ->> 'firstPassRoot', p_journal_proof ->> 'secondPassRoot',
    coalesce(p_journal_proof -> 'events', '[]'::jsonb),
    p_journal_proof ->> 'effectiveTenantLineageRoot'
  ) on conflict (snapshot_id) do nothing;
  select r.* into v_run from private.rv2_restore_v2_runs as r
   where r.snapshot_id = v_snapshot_id;
  if v_run.state = 'QUARANTINED' then
    return jsonb_build_object(
      'format', 'rv-restore-v2-claim-result/1', 'restoreId', v_run.restore_id,
      'state', 'QUARANTINED', 'published', false,
      'blockingReasons', to_jsonb(v_run.blocking_reasons)
    );
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-claim-result/1', 'restoreId', v_run.restore_id,
    'state', v_run.state, 'published', false,
    'manifestTrust', 'VERIFIED_V2', 'journalProofVerified', true,
    'idempotent', v_run.created_at < statement_timestamp()
  );
end
$function$;

create function private.rv2_restore_v2_stage_row_is_valid(p_row jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_normalized jsonb;
  v_key_count integer;
begin
  if jsonb_typeof(p_row) <> 'object' then return false; end if;
  select count(*) into v_key_count from jsonb_object_keys(p_row);
  if v_key_count not in (7, 8, 9)
     or not (p_row ?& array[
       'ordinal', 'dataset', 'recordId', 'tenantLineageId',
       'payload', 'canonicalLine', 'rowSha256'
     ])
     or (p_row ->> 'ordinal') !~ '^(0|[1-9][0-9]{0,12})$'
     or (p_row ->> 'recordId') !~ '^[0-9a-f-]{36}$'
     or (p_row ->> 'tenantLineageId') !~ '^[0-9a-f-]{36}$'
     or p_row ->> 'dataset' not in (
       'tenants', 'memberships', 'connections', 'source_events', 'generations',
       'trade_identities', 'trade_read_models', 'reviews', 'actions',
       'journal_entries', 'risk_rules', 'reports',
       'ledger_generations', 'reconciliation_generations'
     )
     or jsonb_typeof(p_row -> 'payload') <> 'object'
     or octet_length(p_row ->> 'canonicalLine') not between 2 and 1048576
     or p_row ->> 'rowSha256' !~ '^[0-9a-f]{64}$'
     or p_row::text ~* '"(credential|credentials|credential_?(envelope|ciphertext|secret|key)|api_?key|api_?secret|secret_?key|wrapped_?dek|dek|service_?role|private_?key|access_?token|refresh_?token|password|envelope_?(ciphertext|nonce|key)|temporary_?url)"[[:space:]]*:' then
    return false;
  end if;
  if p_row ? 'connectionLineageId'
     and p_row ->> 'connectionLineageId' !~ '^[0-9a-f-]{36}$' then return false; end if;
  if p_row ? 'principalLineageId'
     and p_row ->> 'principalLineageId' !~ '^[0-9a-f-]{36}$' then return false; end if;
  if p_row ->> 'dataset' in (
    'connections', 'source_events', 'generations', 'trade_identities',
    'trade_read_models', 'reviews', 'actions', 'journal_entries',
    'risk_rules', 'reports', 'ledger_generations',
    'reconciliation_generations'
  ) and not p_row ? 'connectionLineageId' then return false; end if;
  if p_row ->> 'dataset' in (
    'memberships', 'reviews', 'actions', 'journal_entries', 'risk_rules', 'reports'
  ) and not p_row ? 'principalLineageId' then return false; end if;
  if p_row ->> 'dataset' = 'memberships'
     and (coalesce(p_row -> 'payload' ->> 'memberRole', '') <> 'OWNER'
       or coalesce(p_row -> 'payload' ->> 'status', '') <> 'ACTIVE') then
    return false;
  end if;
  v_normalized := jsonb_build_object(
    'dataset', p_row ->> 'dataset',
    'recordId', p_row ->> 'recordId',
    'tenantLineageId', p_row ->> 'tenantLineageId',
    'payload', p_row -> 'payload'
  );
  if p_row ? 'connectionLineageId' then
    v_normalized := v_normalized || jsonb_build_object(
      'connectionLineageId', p_row ->> 'connectionLineageId'
    );
  end if;
  if p_row ? 'principalLineageId' then
    v_normalized := v_normalized || jsonb_build_object(
      'principalLineageId', p_row ->> 'principalLineageId'
    );
  end if;
  begin
    if (p_row ->> 'canonicalLine')::jsonb <> v_normalized then return false; end if;
  exception when others then return false;
  end;
  return p_row ->> 'rowSha256' = encode(extensions.digest(
    convert_to((p_row ->> 'canonicalLine') || chr(10), 'utf8'), 'sha256'
  ), 'hex');
end
$function$;

create function public.rv2_restore_v2_stage_batch(
  p_restore_id uuid,
  p_batch_index integer,
  p_total_batches integer,
  p_idempotency_key uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run record;
  v_snapshot record;
  v_existing record;
  v_row jsonb;
  v_batch_sha text;
  v_rows_count integer;
  v_received integer;
  v_received_rows bigint;
  v_plaintext_sha text;
  v_ordered_root text;
  v_tenant_root text;
  v_effective_root text;
  v_row_counts jsonb;
  v_reason text;
  v_owner_count bigint;
  v_suppressed boolean;
begin
  perform private.rv2_require_service_role();
  if p_restore_id is null or p_idempotency_key is null
     or p_total_batches not between 1 and 100000
     or p_batch_index not between 0 and p_total_batches - 1
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 250 then
    raise exception 'restore batch rejected' using errcode = '22023';
  end if;
  select r.* into v_run from private.rv2_restore_v2_runs as r
   where r.restore_id = p_restore_id for update;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  if v_run.state = 'QUARANTINED' then
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'QUARANTINED', 'accepted', false,
      'blockingReasons', to_jsonb(v_run.blocking_reasons)
    );
  end if;
  v_batch_sha := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'restoreId', p_restore_id, 'batchIndex', p_batch_index,
      'totalBatches', p_total_batches, 'rows', p_rows
    )::text, 'utf8'), 'sha256'
  ), 'hex');
  select b.* into v_existing from private.rv2_restore_v2_batches as b
   where b.restore_id = p_restore_id and b.batch_index = p_batch_index;
  if found then
    if v_existing.total_batches <> p_total_batches
       or v_existing.idempotency_key <> p_idempotency_key
       or v_existing.batch_sha256 <> v_batch_sha
       or (v_run.expected_batches is not null
         and v_run.expected_batches <> p_total_batches) then
      raise exception 'restore batch idempotency conflict' using errcode = '40001';
    end if;
    -- An exact replay of a batch persisted by an older implementation must not
    -- be acknowledged if its membership was not exact OWNER/ACTIVE. Conflict
    -- detection remains first so a changed replay keeps the 40001 contract.
    for v_row in select value from jsonb_array_elements(p_rows) loop
      if not private.rv2_restore_v2_stage_row_is_valid(v_row) then
        if v_row::text ~* '"(credential|credentials|credential_?(envelope|ciphertext|secret|key)|api_?key|api_?secret|secret_?key|wrapped_?dek|dek|service_?role|private_?key|access_?token|refresh_?token|password|envelope_?(ciphertext|nonce|key)|temporary_?url)"[[:space:]]*:' then
          raise exception 'CREDENTIAL_FIELD_FORBIDDEN' using errcode = '22023';
        end if;
        if v_row ->> 'dataset' = 'memberships'
           and (coalesce(v_row -> 'payload' ->> 'memberRole', '') <> 'OWNER'
             or coalesce(v_row -> 'payload' ->> 'status', '') <> 'ACTIVE') then
          raise exception 'PERSONAL_TENANT_MEMBERSHIP_INVALID' using errcode = '22023';
        end if;
        raise exception 'restore row rejected' using errcode = '22023';
      end if;
    end loop;
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', v_run.state, 'accepted', true, 'idempotent', true,
      'batchIndex', p_batch_index, 'receivedBatches', v_run.received_batches
    );
  end if;
  if v_run.state not in ('STAGING', 'NOT_READY') then
    raise exception 'restore staging closed' using errcode = '55000';
  end if;
  select s.* into v_snapshot from private.rv2_restore_v2_snapshots as s
   where s.snapshot_id = v_run.snapshot_id;
  if v_snapshot.manifest_trust <> 'VERIFIED_V2'
     or not v_snapshot.signature_verified then
    update private.rv2_restore_v2_runs set state = 'QUARANTINED',
      blocking_reasons = array['LEGACY_UNTRUSTED'], updated_at = statement_timestamp()
     where restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'QUARANTINED', 'accepted', false,
      'blockingReasons', jsonb_build_array('LEGACY_UNTRUSTED')
    );
  end if;
  if not v_run.journal_proof_verified then
    update private.rv2_restore_v2_runs set state = 'NOT_READY',
      blocking_reasons = array['EXTERNAL_JOURNAL_PROOF_MISSING'],
      updated_at = statement_timestamp() where restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'NOT_READY', 'accepted', false,
      'blockingReasons', jsonb_build_array('EXTERNAL_JOURNAL_PROOF_MISSING')
    );
  end if;
  if v_run.expected_batches is not null and v_run.expected_batches <> p_total_batches then
    raise exception 'restore batch count conflict' using errcode = '40001';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if not private.rv2_restore_v2_stage_row_is_valid(v_row) then
      if v_row::text ~* '"(credential|credentials|credential_?(envelope|ciphertext|secret|key)|api_?key|api_?secret|secret_?key|wrapped_?dek|dek|service_?role|private_?key|access_?token|refresh_?token|password|envelope_?(ciphertext|nonce|key)|temporary_?url)"[[:space:]]*:' then
        raise exception 'CREDENTIAL_FIELD_FORBIDDEN' using errcode = '22023';
      end if;
      if v_row ->> 'dataset' = 'memberships'
         and (coalesce(v_row -> 'payload' ->> 'memberRole', '') <> 'OWNER'
           or coalesce(v_row -> 'payload' ->> 'status', '') <> 'ACTIVE') then
        raise exception 'PERSONAL_TENANT_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
      raise exception 'restore row rejected' using errcode = '22023';
    end if;
  end loop;
  v_rows_count := jsonb_array_length(p_rows);
  insert into private.rv2_restore_v2_batches (
    restore_id, batch_index, total_batches, idempotency_key,
    batch_sha256, row_count
  ) values (
    p_restore_id, p_batch_index, p_total_batches, p_idempotency_key,
    v_batch_sha, v_rows_count
  );
  for v_row in select value from jsonb_array_elements(p_rows) loop
    begin
      select exists (
        select 1 from jsonb_array_elements(v_run.journal_events) as e(value)
         where e.value ->> 'tenantLineageId' = v_row ->> 'tenantLineageId'
           and (e.value ->> 'committedAt')::timestamptz >= v_snapshot.created_at
      ) into v_suppressed;
    exception when others then
      raise exception 'external deletion journal event invalid' using errcode = '22023';
    end;
    insert into private.rv2_restore_v2_staging_rows (
      restore_id, row_ordinal, dataset, record_id, tenant_lineage_id,
      connection_lineage_id, principal_lineage_id, payload,
      canonical_line, row_sha256, suppressed_by_deletion, batch_index
    ) values (
      p_restore_id, (v_row ->> 'ordinal')::bigint,
      v_row ->> 'dataset', (v_row ->> 'recordId')::uuid,
      (v_row ->> 'tenantLineageId')::uuid,
      case when v_row ? 'connectionLineageId'
        then (v_row ->> 'connectionLineageId')::uuid else null end,
      case when v_row ? 'principalLineageId'
        then (v_row ->> 'principalLineageId')::uuid else null end,
      v_row -> 'payload', v_row ->> 'canonicalLine',
      v_row ->> 'rowSha256', v_suppressed, p_batch_index
    );
  end loop;
  update private.rv2_restore_v2_runs as r
     set expected_batches = p_total_batches,
         received_batches = r.received_batches + 1,
         received_rows = r.received_rows + v_rows_count,
         updated_at = statement_timestamp()
   where r.restore_id = p_restore_id
   returning r.received_batches, r.received_rows into v_received, v_received_rows;
  if v_received < p_total_batches then
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'STAGING', 'accepted', true, 'idempotent', false,
      'batchIndex', p_batch_index, 'receivedBatches', v_received
    );
  end if;

  if v_received_rows <> v_snapshot.row_count
     or (select min(s.row_ordinal) from private.rv2_restore_v2_staging_rows as s
          where s.restore_id = p_restore_id) <> 0
     or (select max(s.row_ordinal) from private.rv2_restore_v2_staging_rows as s
          where s.restore_id = p_restore_id) <> v_snapshot.row_count - 1 then
    v_reason := 'ORDERED_CONTENT_COUNT_MISMATCH';
  end if;
  select coalesce(jsonb_object_agg(x.dataset, x.row_count order by x.dataset), '{}'::jsonb)
    into v_row_counts
    from (
      select s.dataset, count(*) as row_count
        from private.rv2_restore_v2_staging_rows as s
       where s.restore_id = p_restore_id group by s.dataset
    ) as x;
  if v_reason is null and v_row_counts <> v_snapshot.row_counts then
    v_reason := 'ORDERED_CONTENT_COUNT_MISMATCH';
  end if;
  select encode(extensions.digest(convert_to(coalesce(string_agg(
      s.canonical_line || chr(10), '' order by s.row_ordinal
    ), ''), 'utf8'), 'sha256'), 'hex')
    into v_plaintext_sha
    from private.rv2_restore_v2_staging_rows as s
   where s.restore_id = p_restore_id;
  select encode(extensions.digest(convert_to(
      'rv-restore-v2-ordered-content/1' || chr(0)
      || coalesce(string_agg(
        s.row_ordinal::text || ':' || s.dataset || ':' || s.row_sha256 || chr(10),
        '' order by s.row_ordinal
      ), ''), 'utf8'), 'sha256'), 'hex')
    into v_ordered_root
    from private.rv2_restore_v2_staging_rows as s
   where s.restore_id = p_restore_id;
  select encode(extensions.digest(convert_to(
      'rv-restore-v2-tenant-lineage/1' || chr(0)
      || coalesce(string_agg(x.tenant_lineage_id::text || chr(10), ''
        order by x.tenant_lineage_id), ''), 'utf8'), 'sha256'), 'hex')
    into v_tenant_root
    from (
      select distinct s.tenant_lineage_id
        from private.rv2_restore_v2_staging_rows as s
       where s.restore_id = p_restore_id
    ) as x;
  select encode(extensions.digest(convert_to(
      'rv-restore-v2-effective-tenant-lineage/1' || chr(0)
      || coalesce(string_agg(x.tenant_lineage_id::text || chr(10), ''
        order by x.tenant_lineage_id), ''), 'utf8'), 'sha256'), 'hex')
    into v_effective_root
    from (
      select distinct s.tenant_lineage_id
        from private.rv2_restore_v2_staging_rows as s
       where s.restore_id = p_restore_id and not s.suppressed_by_deletion
    ) as x;
  if v_reason is null and (
    v_plaintext_sha <> v_snapshot.plaintext_stream_sha256
    or v_ordered_root <> v_snapshot.ordered_content_root
    or v_tenant_root <> v_snapshot.tenant_lineage_root
  ) then v_reason := 'ORDERED_CONTENT_ROOT_MISMATCH'; end if;
  if v_reason is null and v_effective_root <> v_run.effective_tenant_lineage_root then
    v_reason := 'EXTERNAL_JOURNAL_EFFECTIVE_ROOT_MISMATCH';
  end if;

  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and s.dataset = 'tenants'
       and (s.record_id <> s.tenant_lineage_id
         or s.connection_lineage_id is not null or s.principal_lineage_id is not null)
  ) then v_reason := 'CROSS_TENANT_REFERENCE'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and not exists (
       select 1 from private.rv2_restore_v2_staging_rows as t
        where t.restore_id = s.restore_id and t.dataset = 'tenants'
          and t.tenant_lineage_id = s.tenant_lineage_id
     )
  ) then v_reason := 'DANGLING_FOREIGN_KEY'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and s.connection_lineage_id is not null
       and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as c
          where c.restore_id = s.restore_id and c.dataset = 'connections'
            and c.connection_lineage_id = s.connection_lineage_id
            and c.tenant_lineage_id = s.tenant_lineage_id
       )
  ) then v_reason := 'CROSS_TENANT_REFERENCE'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and s.principal_lineage_id is not null
       and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as m
          where m.restore_id = s.restore_id and m.dataset = 'memberships'
            and m.principal_lineage_id = s.principal_lineage_id
            and m.tenant_lineage_id = s.tenant_lineage_id
       )
  ) then v_reason := 'CROSS_TENANT_REFERENCE'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as m
     where m.restore_id = p_restore_id and m.dataset = 'memberships'
       and (coalesce(m.payload ->> 'memberRole', '') <> 'OWNER'
         or coalesce(m.payload ->> 'status', '') <> 'ACTIVE')
  ) then v_reason := 'PERSONAL_TENANT_MEMBERSHIP_INVALID'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as m
     where m.restore_id = p_restore_id and m.dataset = 'memberships'
     group by m.tenant_lineage_id
    having count(*) <> 1
  ) then v_reason := 'PERSONAL_TENANT_MEMBERSHIP_INVALID'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as a
     where a.restore_id = p_restore_id and a.dataset = 'actions'
       and a.payload ->> 'reviewLineageId' is not null
       and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as r
          where r.restore_id = a.restore_id and r.dataset = 'reviews'
            and r.record_id::text = a.payload ->> 'reviewLineageId'
            and r.tenant_lineage_id = a.tenant_lineage_id
            and r.connection_lineage_id = a.connection_lineage_id
       )
  ) then v_reason := 'DANGLING_FOREIGN_KEY'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as i
     where i.restore_id = p_restore_id and i.dataset = 'trade_identities'
       and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as g
          where g.restore_id = i.restore_id and g.dataset = 'generations'
            and g.tenant_lineage_id = i.tenant_lineage_id
            and g.connection_lineage_id = i.connection_lineage_id
            and g.payload ->> 'generation' = i.payload ->> 'firstGeneration'
       )
  ) then v_reason := 'DANGLING_FOREIGN_KEY'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as m
     where m.restore_id = p_restore_id and m.dataset = 'trade_read_models'
       and (not exists (
         select 1 from private.rv2_restore_v2_staging_rows as i
          where i.restore_id = m.restore_id and i.dataset = 'trade_identities'
            and i.tenant_lineage_id = m.tenant_lineage_id
            and i.connection_lineage_id = m.connection_lineage_id
            and i.payload ->> 'tradeId' = m.payload ->> 'tradeId'
       ) or not exists (
         select 1 from private.rv2_restore_v2_staging_rows as g
          where g.restore_id = m.restore_id and g.dataset = 'generations'
            and g.tenant_lineage_id = m.tenant_lineage_id
            and g.connection_lineage_id = m.connection_lineage_id
            and g.payload ->> 'generation' = m.payload ->> 'generation'
       ))
  ) then v_reason := 'DANGLING_FOREIGN_KEY'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as r
     where r.restore_id = p_restore_id and r.dataset = 'reviews'
       and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as m
          join private.rv2_restore_v2_staging_rows as i
            on i.restore_id = m.restore_id and i.dataset = 'trade_identities'
           and i.tenant_lineage_id = m.tenant_lineage_id
           and i.connection_lineage_id = m.connection_lineage_id
           and i.payload ->> 'tradeId' = m.payload ->> 'tradeId'
           and i.payload ->> 'sourceLineageSha256'
             = r.payload ->> 'sourceLineageSha256'
          where m.restore_id = r.restore_id and m.dataset = 'trade_read_models'
            and m.tenant_lineage_id = r.tenant_lineage_id
            and m.connection_lineage_id = r.connection_lineage_id
            and m.payload ->> 'tradeId' = r.payload ->> 'tradeId'
            and m.payload ->> 'generation' = r.payload ->> 'tradeGeneration'
       )
  ) then v_reason := 'DANGLING_FOREIGN_KEY'; end if;
  if v_reason is null and exists (
    select 1 from private.rv2_restore_v2_staging_rows as t
     where t.restore_id = p_restore_id and t.dataset = 'tenants'
       and not t.suppressed_by_deletion and not exists (
         select 1 from private.rv2_restore_v2_staging_rows as m
          where m.restore_id = t.restore_id and m.dataset = 'memberships'
            and m.tenant_lineage_id = t.tenant_lineage_id
            and not m.suppressed_by_deletion
            and m.payload ->> 'memberRole' = 'OWNER'
            and m.payload ->> 'status' = 'ACTIVE'
       )
  ) then v_reason := 'OWNER_RECOVERY_INCOMPLETE'; end if;
  if v_reason is not null then
    update private.rv2_restore_v2_runs set state = 'QUARANTINED',
      blocking_reasons = array[v_reason], updated_at = statement_timestamp()
     where restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'QUARANTINED', 'accepted', false,
      'blockingReasons', jsonb_build_array(v_reason)
    );
  end if;
  insert into private.rv2_restore_v2_owner_claims (
    restore_id, principal_lineage_id, tenant_lineage_id, recovery_tag_hash
  )
  select p_restore_id, m.principal_lineage_id, m.tenant_lineage_id,
         m.payload ->> 'recoveryTagHash'
    from private.rv2_restore_v2_staging_rows as m
   where m.restore_id = p_restore_id and m.dataset = 'memberships'
     and not m.suppressed_by_deletion
     and m.payload ->> 'memberRole' = 'OWNER'
     and m.payload ->> 'status' = 'ACTIVE';
  select count(*) into v_owner_count
    from private.rv2_restore_v2_owner_claims as c where c.restore_id = p_restore_id;
  if v_owner_count = 0 then
    update private.rv2_restore_v2_runs set state = 'QUARANTINED',
      blocking_reasons = array['OWNER_RECOVERY_INCOMPLETE'], graph_verified = true,
      updated_at = statement_timestamp() where restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
      'state', 'QUARANTINED', 'accepted', false,
      'blockingReasons', jsonb_build_array('OWNER_RECOVERY_INCOMPLETE')
    );
  end if;
  update private.rv2_restore_v2_runs set state = 'AWAITING_OWNER_CLAIMS',
    blocking_reasons = array['OWNER_RECOVERY_INCOMPLETE'], graph_verified = true,
    updated_at = statement_timestamp() where restore_id = p_restore_id;
  return jsonb_build_object(
    'format', 'rv-restore-v2-stage-result/1', 'restoreId', p_restore_id,
    'state', 'AWAITING_OWNER_CLAIMS', 'accepted', true,
    'receivedBatches', v_received, 'receivedRows', v_received_rows,
    'graphVerified', true, 'ownerClaimsRequired', v_owner_count,
    'credentialsAccepted', 0
  );
end
$function$;

create function public.rv2_restore_v2_issue_owner_invite(
  p_restore_id uuid,
  p_principal_lineage_id uuid,
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_claim record;
  v_invite_claim text;
  v_invite_hash text;
  v_nonce uuid;
  v_generation integer;
  v_idempotent boolean := false;
begin
  perform private.rv2_require_service_role();
  if p_delivery_id is null then
    raise exception 'recovery delivery id required' using errcode = '22023';
  end if;
  select c.* into v_claim
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.principal_lineage_id = p_principal_lineage_id
   for update;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from private.rv2_restore_v2_runs as r
     where r.restore_id = p_restore_id and r.state = 'AWAITING_OWNER_CLAIMS'
  ) then raise exception 'restore invite unavailable' using errcode = '55000'; end if;
  if v_claim.state = 'CLAIMED' then
    raise exception 'recovery invite already claimed' using errcode = '40001';
  end if;
  if v_claim.state = 'INVITED' and v_claim.invite_delivery_id = p_delivery_id then
    v_nonce := v_claim.invite_nonce;
    v_generation := v_claim.invite_generation;
    v_idempotent := true;
  else
    v_nonce := gen_random_uuid();
    v_generation := v_claim.invite_generation + 1;
  end if;
  v_invite_claim := encode(extensions.hmac(
    convert_to(
      'rv-restore-v2-owner-invite/1' || chr(0) || p_restore_id::text
      || chr(0) || p_principal_lineage_id::text || chr(0)
      || v_generation::text || chr(0) || v_nonce::text || chr(0)
      || v_claim.recovery_tag_hash,
      'utf8'
    ),
    convert_to(private.rv2_restore_v2_pepper(), 'utf8'),
    'sha256'
  ), 'hex');
  v_invite_hash := encode(extensions.digest(
    convert_to(v_invite_claim, 'utf8'), 'sha256'
  ), 'hex');
  if not v_idempotent then
    update private.rv2_restore_v2_owner_claims as c
       set state = 'INVITED', invite_claim_hash = v_invite_hash,
           invite_delivery_id = p_delivery_id, invite_nonce = v_nonce,
           invite_generation = v_generation,
           invited_at = statement_timestamp(),
           invite_expires_at = statement_timestamp() + interval '10 minutes'
     where c.restore_id = p_restore_id
       and c.principal_lineage_id = p_principal_lineage_id;
  elsif v_claim.invite_claim_hash <> v_invite_hash
     or v_claim.invite_expires_at <= statement_timestamp() then
    raise exception 'recovery invite conflict' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-owner-invite/1',
    'restoreId', p_restore_id,
    'principalLineageId', p_principal_lineage_id,
    'inviteClaim', v_invite_claim,
    'state', 'INVITED', 'inviteGeneration', v_generation,
    'expiresAt', case when v_idempotent then v_claim.invite_expires_at
      else statement_timestamp() + interval '10 minutes' end,
    'idempotent', v_idempotent,
    'deliveryRequired', 'SERVER_VERIFIED_EMAIL_ONLY'
  );
end
$function$;

create function public.rv2_restore_v2_claim_owner(
  p_restore_id uuid,
  p_principal_lineage_id uuid,
  p_invite_claim text,
  p_subject uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_claim record;
  v_user record;
  v_recovery_tag text;
  v_recovery_hash text;
  v_invite_hash text;
  v_remaining bigint;
begin
  perform private.rv2_require_service_role();
  if p_invite_claim !~ '^[0-9a-f]{64}$' or p_subject is null then
    raise exception 'recovery claim rejected' using errcode = '22023';
  end if;
  select c.* into v_claim
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.principal_lineage_id = p_principal_lineage_id
   for update;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  if v_claim.state = 'CLAIMED' then
    if v_claim.claimed_user_id <> p_subject then
      raise exception 'owner recovery claim replay detected' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'format', 'rv-restore-v2-owner-claim/1', 'restoreId', p_restore_id,
      'principalLineageId', p_principal_lineage_id,
      'claimedUserId', p_subject, 'state', 'CLAIMED', 'idempotent', true
    );
  end if;
  if v_claim.state <> 'INVITED' then
    raise exception 'owner recovery invite required' using errcode = '55000';
  end if;
  if v_claim.invite_expires_at <= statement_timestamp() then
    raise exception 'owner recovery invite expired' using errcode = 'P0002';
  end if;
  select u.id, u.email, u.email_confirmed_at into v_user
    from auth.users as u where u.id = p_subject;
  if not found or v_user.email is null or v_user.email_confirmed_at is null then
    raise exception 'server-verified email recovery tag unavailable'
      using errcode = 'P0002';
  end if;
  v_recovery_tag := private.rv2_restore_v2_recovery_tag(
    v_user.email, p_principal_lineage_id
  );
  v_recovery_hash := encode(extensions.digest(
    convert_to(v_recovery_tag, 'utf8'), 'sha256'
  ), 'hex');
  v_invite_hash := encode(extensions.digest(
    convert_to(p_invite_claim, 'utf8'), 'sha256'
  ), 'hex');
  if v_recovery_hash <> v_claim.recovery_tag_hash then
    raise exception 'verified recovery email mismatch' using errcode = 'P0002';
  end if;
  if v_invite_hash <> v_claim.invite_claim_hash then
    raise exception 'owner recovery invite mismatch' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from private.rv2_restore_v2_owner_claims as c
     where c.restore_id = p_restore_id and c.claimed_user_id = p_subject
       and c.principal_lineage_id <> p_principal_lineage_id
  ) then raise exception 'owner recovery identity conflict' using errcode = '40001'; end if;
  update private.rv2_restore_v2_owner_claims as c
     set state = 'CLAIMED', claimed_user_id = p_subject,
         claimed_at = statement_timestamp()
   where c.restore_id = p_restore_id
     and c.principal_lineage_id = p_principal_lineage_id
     and c.state = 'INVITED';
  select count(*) into v_remaining
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id and c.state <> 'CLAIMED';
  if v_remaining = 0 then
    update private.rv2_restore_v2_runs as r
       set state = 'PUBLISHABLE', blocking_reasons = array[]::text[],
           updated_at = statement_timestamp()
     where r.restore_id = p_restore_id
       and r.state = 'AWAITING_OWNER_CLAIMS'
       and r.graph_verified and r.journal_proof_verified;
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-owner-claim/1', 'restoreId', p_restore_id,
    'principalLineageId', p_principal_lineage_id,
    'claimedUserId', p_subject, 'state', 'CLAIMED',
    'idempotent', false, 'remainingOwnerClaims', v_remaining
  );
end
$function$;

create function public.rv2_restore_v2_recover_owner_by_verified_subject(
  p_restore_id uuid,
  p_subject uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run record;
  v_user record;
  v_claim record;
  v_existing_count bigint;
  v_existing_principal uuid;
  v_match_count bigint;
  v_match_principal uuid;
  v_remaining bigint;
  v_recovery_tag text;
  v_recovery_hash text;
  v_invite_claim text;
  v_invite_hash text;
  v_nonce uuid;
  v_delivery_id uuid;
  v_generation integer;
begin
  perform private.rv2_require_service_role();
  if p_restore_id is null or p_subject is null then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;
  select u.id, u.email, u.email_confirmed_at into v_user
    from auth.users as u
   where u.id = p_subject;
  if not found or v_user.email is null or v_user.email_confirmed_at is null then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;

  -- Lock every claim before the run row, matching the existing claim-owner lock
  -- order. This makes the unique verified-email match and state transition one
  -- transaction without exposing an invite claim to the Edge caller.
  perform 1
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
   order by c.principal_lineage_id
   for update;
  select r.* into v_run
    from private.rv2_restore_v2_runs as r
   where r.restore_id = p_restore_id
   for update;
  if not found then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;

  select count(*),
         (array_agg(c.principal_lineage_id order by c.principal_lineage_id))[1]
    into v_existing_count, v_existing_principal
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.state = 'CLAIMED'
     and c.claimed_user_id = p_subject;
  if v_existing_count > 1 then
    raise exception 'owner recovery identity is ambiguous' using errcode = '40001';
  end if;
  if v_existing_count = 1 then
    if v_run.state not in ('AWAITING_OWNER_CLAIMS', 'PUBLISHABLE')
       or not v_run.graph_verified or not v_run.journal_proof_verified then
      raise exception 'owner recovery unavailable' using errcode = 'P0002';
    end if;
    select c.* into v_claim
      from private.rv2_restore_v2_owner_claims as c
     where c.restore_id = p_restore_id
       and c.principal_lineage_id = v_existing_principal;
    v_recovery_tag := private.rv2_restore_v2_recovery_tag(
      v_user.email, v_existing_principal
    );
    v_recovery_hash := encode(extensions.digest(
      convert_to(v_recovery_tag, 'utf8'), 'sha256'
    ), 'hex');
    if v_recovery_hash <> v_claim.recovery_tag_hash then
      raise exception 'owner recovery unavailable' using errcode = 'P0002';
    end if;
    select count(*) into v_remaining
      from private.rv2_restore_v2_owner_claims as c
     where c.restore_id = p_restore_id and c.state <> 'CLAIMED';
    return jsonb_build_object(
      'format', 'rv-restore-v2-owner-recovery/1',
      'restoreId', p_restore_id,
      'state', 'CLAIMED', 'claimed', true, 'idempotent', true,
      'remainingOwnerClaims', v_remaining,
      'inviteClaimDisclosed', false,
      'recoveryIdentitySource', 'AUTH_VERIFIED_SERVER_SIDE'
    );
  end if;

  if v_run.state <> 'AWAITING_OWNER_CLAIMS'
     or not v_run.graph_verified or not v_run.journal_proof_verified then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;
  select count(*),
         (array_agg(c.principal_lineage_id order by c.principal_lineage_id))[1]
    into v_match_count, v_match_principal
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.state in ('PENDING_INVITE', 'INVITED')
     and encode(extensions.digest(
       convert_to(private.rv2_restore_v2_recovery_tag(
         v_user.email, c.principal_lineage_id
       ), 'utf8'),
       'sha256'
     ), 'hex') = c.recovery_tag_hash;
  if v_match_count = 0 then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;
  if v_match_count <> 1 then
    raise exception 'owner recovery identity is ambiguous' using errcode = '40001';
  end if;
  if exists (
    select 1 from private.rv2_restore_v2_owner_claims as c
     where c.restore_id = p_restore_id and c.claimed_user_id = p_subject
       and c.principal_lineage_id <> v_match_principal
  ) then
    raise exception 'owner recovery identity conflict' using errcode = '40001';
  end if;
  select c.* into v_claim
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.principal_lineage_id = v_match_principal;

  v_recovery_tag := private.rv2_restore_v2_recovery_tag(
    v_user.email, v_match_principal
  );
  v_recovery_hash := encode(extensions.digest(
    convert_to(v_recovery_tag, 'utf8'), 'sha256'
  ), 'hex');
  if v_recovery_hash <> v_claim.recovery_tag_hash then
    raise exception 'owner recovery unavailable' using errcode = 'P0002';
  end if;

  -- The invite material exists only inside this transaction so the table keeps
  -- its existing CLAIMED-state integrity contract. No claim, hash, nonce or
  -- delivery identifier is returned to the user or the GitHub runner.
  v_nonce := gen_random_uuid();
  v_delivery_id := gen_random_uuid();
  v_generation := v_claim.invite_generation + 1;
  v_invite_claim := encode(extensions.hmac(
    convert_to(
      'rv-restore-v2-owner-invite/1' || chr(0) || p_restore_id::text
      || chr(0) || v_match_principal::text || chr(0)
      || v_generation::text || chr(0) || v_nonce::text || chr(0)
      || v_claim.recovery_tag_hash,
      'utf8'
    ),
    convert_to(private.rv2_restore_v2_pepper(), 'utf8'),
    'sha256'
  ), 'hex');
  v_invite_hash := encode(extensions.digest(
    convert_to(v_invite_claim, 'utf8'), 'sha256'
  ), 'hex');
  update private.rv2_restore_v2_owner_claims as c
     set state = 'CLAIMED', invite_claim_hash = v_invite_hash,
         invite_delivery_id = v_delivery_id, invite_nonce = v_nonce,
         invite_generation = v_generation,
         invited_at = statement_timestamp(),
         invite_expires_at = statement_timestamp() + interval '10 minutes',
         claimed_user_id = p_subject, claimed_at = statement_timestamp()
   where c.restore_id = p_restore_id
     and c.principal_lineage_id = v_match_principal
     and c.state in ('PENDING_INVITE', 'INVITED');
  if not found then
    raise exception 'owner recovery identity conflict' using errcode = '40001';
  end if;

  select count(*) into v_remaining
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id and c.state <> 'CLAIMED';
  if v_remaining = 0 then
    update private.rv2_restore_v2_runs as r
       set state = 'PUBLISHABLE', blocking_reasons = array[]::text[],
           updated_at = statement_timestamp()
     where r.restore_id = p_restore_id
       and r.state = 'AWAITING_OWNER_CLAIMS'
       and r.graph_verified and r.journal_proof_verified;
    if not found then
      raise exception 'owner recovery unavailable' using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-owner-recovery/1',
    'restoreId', p_restore_id,
    'state', 'CLAIMED', 'claimed', true, 'idempotent', false,
    'remainingOwnerClaims', v_remaining,
    'inviteClaimDisclosed', false,
    'recoveryIdentitySource', 'AUTH_VERIFIED_SERVER_SIDE'
  );
end
$function$;

create function public.rv2_restore_v2_status(p_restore_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run record;
  v_required bigint;
  v_claimed bigint;
begin
  perform private.rv2_require_service_role();
  select r.* into v_run from private.rv2_restore_v2_runs as r
   where r.restore_id = p_restore_id;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  select count(*), count(*) filter (where c.state = 'CLAIMED')
    into v_required, v_claimed
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id;
  return jsonb_build_object(
    'format', 'rv-restore-v2-status/1', 'restoreId', p_restore_id,
    'snapshotId', v_run.snapshot_id, 'state', v_run.state,
    'published', v_run.state = 'PUBLISHED',
    'blockingReasons', to_jsonb(v_run.blocking_reasons),
    'graphVerified', v_run.graph_verified,
    'journalProofVerified', v_run.journal_proof_verified,
    'finalJournalProofVerified', v_run.journal_final_verified_at is not null,
    'receivedBatches', v_run.received_batches,
    'expectedBatches', v_run.expected_batches,
    'ownerClaimsRequired', v_required, 'ownerClaimsCompleted', v_claimed,
    'credentialsRestored', v_run.credentials_restored,
    'connectionStateAfterRestore', 'RECONNECT_REQUIRED'
  );
end
$function$;

create function private.rv2_restore_v2_owner_for_tenant(
  p_restore_id uuid,
  p_tenant_lineage_id uuid
)
returns uuid
language sql
security definer
set search_path = pg_catalog
as $function$
  select (array_agg(c.claimed_user_id order by c.claimed_user_id))[1]
    from private.rv2_restore_v2_owner_claims as c
   where c.restore_id = p_restore_id
     and c.tenant_lineage_id = p_tenant_lineage_id
     and c.state = 'CLAIMED'
$function$;

create function public.rv2_restore_v2_publish(
  p_restore_id uuid,
  p_journal_proof jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run record;
  v_snapshot record;
  v_reason text;
  v_capacity jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_effective_root text;
  v_final_proof_sha256 text;
begin
  perform private.rv2_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('rv2-restore-v2-publish', 0));
  -- Keep an in-place source deletion from committing between the final proof
  -- check and publication.  Cross-project recovery still needs the mandatory
  -- fresh R2 re-proof supplied to this call.
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-deletion-journal-32d-budget', 0
  ));
  select r.* into v_run from private.rv2_restore_v2_runs as r
   where r.restore_id = p_restore_id for update;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  if v_run.state = 'PUBLISHED' then
    return jsonb_build_object(
      'format', 'rv-restore-v2-publish-result/1', 'restoreId', p_restore_id,
      'state', 'PUBLISHED', 'published', true, 'idempotent', true,
      'credentialsRestored', 0, 'connectionState', 'RECONNECT_REQUIRED',
      'finalJournalProofVerified', v_run.journal_final_verified_at is not null
    );
  end if;
  select s.* into v_snapshot from private.rv2_restore_v2_snapshots as s
   where s.snapshot_id = v_run.snapshot_id;
  if to_regclass('private.rv2_ops_capacity_observations') is not null
     and to_regprocedure('public.rv2_service_get_operational_health()') is not null then
    begin
      execute 'select public.rv2_service_get_operational_health()' into v_capacity;
    exception when others then
      v_capacity := null;
    end;
  end if;
  if v_snapshot.manifest_trust <> 'VERIFIED_V2' or not v_snapshot.signature_verified then
    v_reason := 'LEGACY_UNTRUSTED';
  elsif v_run.state not in ('PUBLISHABLE', 'NOT_READY') or not v_run.graph_verified then
    v_reason := 'OWNER_RECOVERY_INCOMPLETE';
  elsif not v_run.journal_proof_verified then
    v_reason := 'EXTERNAL_JOURNAL_PROOF_MISSING';
  elsif not private.rv2_restore_v2_journal_proof_is_valid(
    p_journal_proof,
    v_snapshot.created_at,
    v_snapshot.external_journal_root,
    v_run.journal_range_end
  ) then
    v_reason := 'FINAL_JOURNAL_PROOF_REQUIRED';
  elsif (p_journal_proof ->> 'rangeStart')::timestamptz
      <> v_run.journal_range_start then
    v_reason := 'FINAL_JOURNAL_PROOF_REQUIRED';
  end if;

  if v_reason is null then
    v_range_start := (p_journal_proof ->> 'rangeStart')::timestamptz;
    v_range_end := (p_journal_proof ->> 'rangeEnd')::timestamptz;
    -- A same-project intent created after the proof, or omitted from it, makes
    -- the proof stale.  The advisory lock prevents a new one until commit.
    if exists (
      select 1
        from private.rv2_restore_v2_deletion_intents as i
       where i.created_at >= v_snapshot.created_at
         and (i.created_at > v_range_end or not exists (
           select 1
             from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
            where e.value ->> 'eventId' = i.event_id::text
              and e.value ->> 'tenantLineageId' = i.tenant_lineage_id::text
              and e.value ->> 'operation' = i.operation
              and e.value ->> 'committedAt' = to_char(
                i.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
         ))
    ) then
      v_reason := 'FINAL_JOURNAL_PROOF_REQUIRED';
    end if;
  end if;

  if v_reason is null then
    -- Derive the final effective lineage inside PostgreSQL.  Caller-supplied
    -- lineage is only an assertion; it never decides which rows are restored.
    select encode(extensions.digest(convert_to(
        'rv-restore-v2-effective-tenant-lineage/1' || chr(0)
        || coalesce(string_agg(x.tenant_lineage_id::text || chr(10), ''
          order by x.tenant_lineage_id), ''), 'utf8'), 'sha256'), 'hex')
      into v_effective_root
      from (
        select distinct s.tenant_lineage_id
          from private.rv2_restore_v2_staging_rows as s
         where s.restore_id = p_restore_id and s.dataset = 'tenants'
           and not exists (
             select 1
               from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
              where e.value ->> 'tenantLineageId' = s.tenant_lineage_id::text
                and (e.value ->> 'committedAt')::timestamptz
                  >= v_snapshot.created_at
           )
      ) as x;
    if v_effective_root <> (p_journal_proof ->> 'effectiveTenantLineageRoot') then
      v_reason := 'FINAL_JOURNAL_PROOF_REQUIRED';
    end if;
  end if;

  if v_reason is null and (
    exists (
      select 1
        from private.rv2_restore_v2_staging_rows as t
       where t.restore_id = p_restore_id and t.dataset = 'tenants'
         and not exists (
           select 1
             from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
            where e.value ->> 'tenantLineageId' = t.tenant_lineage_id::text
              and (e.value ->> 'committedAt')::timestamptz
                >= v_snapshot.created_at
         )
         and not exists (
           select 1 from private.rv2_restore_v2_owner_claims as c
            where c.restore_id = p_restore_id
              and c.tenant_lineage_id = t.tenant_lineage_id
              and c.state = 'CLAIMED'
         )
    ) or exists (
      select 1
        from private.rv2_restore_v2_owner_claims as c
       where c.restore_id = p_restore_id and c.state <> 'CLAIMED'
         and not exists (
           select 1
             from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
            where e.value ->> 'tenantLineageId' = c.tenant_lineage_id::text
              and (e.value ->> 'committedAt')::timestamptz
                >= v_snapshot.created_at
         )
    )
  ) then
    v_reason := 'OWNER_RECOVERY_INCOMPLETE';
  end if;

  if v_reason is null and v_capacity is null then
    v_reason := 'CAPACITY_MIGRATION_003_REQUIRED';
  elsif v_reason is null
     and coalesce((v_capacity ->> 'externalUsageKnown')::boolean, false) is not true then
    v_reason := 'TARGET_CAPACITY_OBSERVATION_REQUIRED';
  elsif v_reason is null
     and (coalesce((v_capacity ->> 'maintenanceReadOnly')::boolean, true) is true
     or coalesce((v_capacity ->> 'admissionAllowed')::boolean, false) is not true
     or coalesce((v_capacity ->> 'historyAllowed')::boolean, false) is not true) then
    v_reason := 'TARGET_CAPACITY_GUARD_BLOCKED';
  elsif v_reason is null and not private.rv2_restore_v2_project_is_empty() then
    v_reason := 'TARGET_PROJECT_NOT_EMPTY';
  end if;
  if v_reason is not null then
    update private.rv2_restore_v2_runs as r
       set state = case when v_reason in ('OWNER_RECOVERY_INCOMPLETE',
          'EXTERNAL_JOURNAL_PROOF_MISSING', 'CAPACITY_MIGRATION_003_REQUIRED',
          'FINAL_JOURNAL_PROOF_REQUIRED', 'TARGET_CAPACITY_OBSERVATION_REQUIRED',
          'TARGET_CAPACITY_GUARD_BLOCKED')
          then 'NOT_READY' else 'QUARANTINED' end,
           blocking_reasons = array[v_reason], updated_at = statement_timestamp()
     where r.restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-publish-result/1', 'restoreId', p_restore_id,
       'state', case when v_reason in ('OWNER_RECOVERY_INCOMPLETE',
         'EXTERNAL_JOURNAL_PROOF_MISSING', 'CAPACITY_MIGRATION_003_REQUIRED',
         'FINAL_JOURNAL_PROOF_REQUIRED', 'TARGET_CAPACITY_OBSERVATION_REQUIRED',
         'TARGET_CAPACITY_GUARD_BLOCKED')
         then 'NOT_READY' else 'QUARANTINED' end,
      'published', false, 'blockingReasons', jsonb_build_array(v_reason),
      'credentialsRestored', 0
    );
  end if;

  -- This block is a PostgreSQL subtransaction. Any mid-publish failure rolls
  -- every live-table insert back before the run is marked QUARANTINED.
  begin
    -- Re-apply suppression from the final proof, not the claim-time proof.
    -- This is an exact replacement so an inconsistent proof cannot leave a
    -- stale suppression decision hidden in the staging table.
    update private.rv2_restore_v2_staging_rows as s
       set suppressed_by_deletion = exists (
         select 1
           from jsonb_array_elements(p_journal_proof -> 'events') as e(value)
          where e.value ->> 'tenantLineageId' = s.tenant_lineage_id::text
            and (e.value ->> 'committedAt')::timestamptz
              >= v_snapshot.created_at
       )
     where s.restore_id = p_restore_id;

    insert into private.rv2_restore_v2_tenant_maps (
      restore_id, tenant_lineage_id
    )
    select p_restore_id, s.tenant_lineage_id
      from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and s.dataset = 'tenants'
       and not s.suppressed_by_deletion
     order by s.tenant_lineage_id;

    insert into private.rv2_restore_v2_connection_maps (
      restore_id, connection_lineage_id, tenant_lineage_id
    )
    select p_restore_id, s.connection_lineage_id, s.tenant_lineage_id
      from private.rv2_restore_v2_staging_rows as s
     where s.restore_id = p_restore_id and s.dataset = 'connections'
       and not s.suppressed_by_deletion
     order by s.connection_lineage_id;

    insert into public.rv2_tenants (
      tenant_id, status, created_at
    )
    select m.target_tenant_id, 'ACTIVE',
           (s.payload ->> 'createdAt')::timestamptz
      from private.rv2_restore_v2_tenant_maps as m
      join private.rv2_restore_v2_staging_rows as s
        on s.restore_id = m.restore_id and s.dataset = 'tenants'
       and s.tenant_lineage_id = m.tenant_lineage_id
     where m.restore_id = p_restore_id and not s.suppressed_by_deletion;

    -- Personal Beta restores exactly one verified OWNER principal per tenant.
    -- Shared memberships remain outside this contract and fail during staging.
    insert into public.rv2_memberships (
      tenant_id, user_id, member_role, status, membership_version,
      created_at, updated_at
    )
    select tm.target_tenant_id, c.claimed_user_id, 'OWNER', 'ACTIVE',
           greatest(1, (s.payload ->> 'membershipVersion')::bigint),
           (s.payload ->> 'createdAt')::timestamptz,
           greatest(
             (s.payload ->> 'updatedAt')::timestamptz,
             c.claimed_at
           )
      from private.rv2_restore_v2_owner_claims as c
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = c.restore_id
       and tm.tenant_lineage_id = c.tenant_lineage_id
      join private.rv2_restore_v2_staging_rows as s
        on s.restore_id = c.restore_id and s.dataset = 'memberships'
       and s.principal_lineage_id = c.principal_lineage_id
     where c.restore_id = p_restore_id and c.state = 'CLAIMED'
       and not s.suppressed_by_deletion;

    insert into public.rv2_connections (
      tenant_id, connection_id, provider, provider_scope_hash,
      credential_version, status, permission_state, permission_evidence,
      consent_version, current_generation, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           s.payload ->> 'provider', s.payload ->> 'providerScopeHash',
           1, 'RECONNECT_REQUIRED', 'UNKNOWN', null,
           s.payload ->> 'consentVersion',
           greatest(0, (s.payload ->> 'currentGeneration')::bigint),
           (s.payload ->> 'createdAt')::timestamptz,
           greatest((s.payload ->> 'updatedAt')::timestamptz, statement_timestamp())
      from private.rv2_restore_v2_connection_maps as cm
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = cm.restore_id
       and tm.tenant_lineage_id = cm.tenant_lineage_id
      join private.rv2_restore_v2_staging_rows as s
        on s.restore_id = cm.restore_id and s.dataset = 'connections'
       and s.connection_lineage_id = cm.connection_lineage_id
     where cm.restore_id = p_restore_id and not s.suppressed_by_deletion;

    insert into public.rv2_source_events (
      tenant_id, connection_id, event_id, sync_job_id, dataset,
      provider_event_id, event_time, event_body, event_sha256,
      source_observed_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           (s.payload ->> 'syncJobId')::uuid, s.payload ->> 'dataset',
           s.payload ->> 'providerEventId',
           (s.payload ->> 'eventTime')::timestamptz,
           s.payload -> 'eventBody', s.payload ->> 'eventSha256',
           (s.payload ->> 'sourceObservedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'source_events'
       and not s.suppressed_by_deletion;

    insert into public.rv2_generations (
      tenant_id, connection_id, generation, generation_id,
      credential_version, source_job_ids, coverage, reconciliation,
      capabilities, source_root_sha256, source_event_count,
      projection_sha256, trade_model_count,
      manifest_sha256, status, published_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           (s.payload ->> 'generation')::bigint, s.record_id, 1,
           array(select jsonb_array_elements_text(s.payload -> 'sourceJobIds')::uuid),
           s.payload -> 'coverage', s.payload -> 'reconciliation',
           s.payload -> 'capabilities', s.payload ->> 'sourceRootSha256',
           (s.payload ->> 'sourceEventCount')::bigint,
           s.payload ->> 'projectionSha256',
           (s.payload ->> 'tradeModelCount')::bigint,
           s.payload ->> 'manifestSha256',
           s.payload ->> 'status', (s.payload ->> 'publishedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'generations'
       and not s.suppressed_by_deletion;

    -- Generation-backed identity rows must precede generation read models;
    -- both must precede reviews because the latter has a composite FK.
    insert into public.rv2_trade_identities (
      tenant_id, connection_id, trade_id, id_protocol,
      source_lineage_sha256, first_generation, first_seen_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           s.payload ->> 'tradeId', s.payload ->> 'idProtocol',
           s.payload ->> 'sourceLineageSha256',
           (s.payload ->> 'firstGeneration')::bigint,
           (s.payload ->> 'firstSeenAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'trade_identities'
       and not s.suppressed_by_deletion;

    insert into public.rv2_trade_read_models (
      tenant_id, connection_id, trade_id, generation, model_protocol,
      payload, payload_sha256, projected_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           s.payload ->> 'tradeId', (s.payload ->> 'generation')::bigint,
           s.payload ->> 'modelProtocol', s.payload -> 'payload',
           s.payload ->> 'payloadSha256',
           (s.payload ->> 'projectedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'trade_read_models'
       and not s.suppressed_by_deletion;

    insert into public.rv2_reviews (
      tenant_id, connection_id, review_id, trade_id, trade_generation,
      source_lineage_sha256, version, payload,
      payload_sha256, created_by, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           s.payload ->> 'tradeId',
           (s.payload ->> 'tradeGeneration')::bigint,
           s.payload ->> 'sourceLineageSha256',
           (s.payload ->> 'version')::bigint,
           s.payload -> 'payload', s.payload ->> 'payloadSha256',
           private.rv2_restore_v2_owner_for_tenant(p_restore_id, s.tenant_lineage_id),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'reviews'
       and not s.suppressed_by_deletion;

    insert into public.rv2_actions (
      tenant_id, connection_id, action_id, trade_id, review_id, status, version,
      payload, created_by, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           s.payload ->> 'tradeId',
           nullif(s.payload ->> 'reviewLineageId', '')::uuid,
           s.payload ->> 'status', (s.payload ->> 'version')::bigint,
           s.payload -> 'payload',
           private.rv2_restore_v2_owner_for_tenant(p_restore_id, s.tenant_lineage_id),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'actions'
       and not s.suppressed_by_deletion;

    insert into public.rv2_journal_entries (
      tenant_id, connection_id, journal_id, journal_day, version,
      payload, created_by, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           (s.payload ->> 'journalDay')::date,
           (s.payload ->> 'version')::bigint, s.payload -> 'payload',
           private.rv2_restore_v2_owner_for_tenant(p_restore_id, s.tenant_lineage_id),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'journal_entries'
       and not s.suppressed_by_deletion;

    insert into public.rv2_risk_rules (
      tenant_id, connection_id, rule_id, status, version,
      payload, created_by, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           s.payload ->> 'status', (s.payload ->> 'version')::bigint,
           s.payload -> 'payload',
           private.rv2_restore_v2_owner_for_tenant(p_restore_id, s.tenant_lineage_id),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'risk_rules'
       and not s.suppressed_by_deletion;

    insert into public.rv2_reports (
      tenant_id, connection_id, report_id, report_type, period_start,
      period_end, source_generation, version, payload, payload_sha256,
      created_by, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id, s.record_id,
           s.payload ->> 'reportType', (s.payload ->> 'periodStart')::date,
           (s.payload ->> 'periodEnd')::date,
           (s.payload ->> 'sourceGeneration')::bigint,
           (s.payload ->> 'version')::bigint,
           s.payload -> 'payload', s.payload ->> 'payloadSha256',
           private.rv2_restore_v2_owner_for_tenant(p_restore_id, s.tenant_lineage_id),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'reports'
       and not s.suppressed_by_deletion;

    insert into public.rv2_ledger_generations (
      tenant_id, connection_id, generation, status, projection_sha256,
      reason_codes, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           (s.payload ->> 'generation')::bigint, s.payload ->> 'status',
           nullif(s.payload ->> 'projectionSha256', ''),
           array(select jsonb_array_elements_text(s.payload -> 'reasonCodes')),
           (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id and s.dataset = 'ledger_generations'
       and not s.suppressed_by_deletion;

    insert into public.rv2_reconciliation_generations (
      tenant_id, connection_id, generation, state, status, reason_codes,
      checks, created_at, updated_at
    )
    select tm.target_tenant_id, cm.target_connection_id,
           (s.payload ->> 'generation')::bigint, s.payload ->> 'state',
           s.payload ->> 'status',
           array(select jsonb_array_elements_text(s.payload -> 'reasonCodes')),
           s.payload -> 'checks', (s.payload ->> 'createdAt')::timestamptz,
           (s.payload ->> 'updatedAt')::timestamptz
      from private.rv2_restore_v2_staging_rows as s
      join private.rv2_restore_v2_tenant_maps as tm
        on tm.restore_id = s.restore_id
       and tm.tenant_lineage_id = s.tenant_lineage_id
      join private.rv2_restore_v2_connection_maps as cm
        on cm.restore_id = s.restore_id
       and cm.connection_lineage_id = s.connection_lineage_id
     where s.restore_id = p_restore_id
       and s.dataset = 'reconciliation_generations'
       and not s.suppressed_by_deletion;

    -- Re-establish stable lineage in the new project without retaining old
    -- Auth UUIDs or old live-table identifiers as target ownership.
    insert into private.rv2_restore_v2_tenant_lineage (
      tenant_lineage_id, source_tenant_id
    )
    select m.tenant_lineage_id, m.target_tenant_id
      from private.rv2_restore_v2_tenant_maps as m
     where m.restore_id = p_restore_id;
    insert into private.rv2_restore_v2_principal_lineage (
      principal_lineage_id, tenant_lineage_id, source_user_id,
      recovery_tag_hash, member_role
    )
    select c.principal_lineage_id, c.tenant_lineage_id, c.claimed_user_id,
           c.recovery_tag_hash, 'OWNER'
      from private.rv2_restore_v2_owner_claims as c
     where c.restore_id = p_restore_id and c.state = 'CLAIMED';
    insert into private.rv2_restore_v2_connection_lineage (
      connection_lineage_id, tenant_lineage_id, source_connection_id
    )
    select m.connection_lineage_id, m.tenant_lineage_id,
           m.target_connection_id
      from private.rv2_restore_v2_connection_maps as m
     where m.restore_id = p_restore_id;

    -- All deferred constraints are checked before the publish marker changes.
    set constraints all immediate;
  exception when others then
    update private.rv2_restore_v2_runs as r
       set state = 'QUARANTINED',
           blocking_reasons = array['PUBLISH_TRANSACTION_ROLLED_BACK'],
           updated_at = statement_timestamp()
     where r.restore_id = p_restore_id;
    return jsonb_build_object(
      'format', 'rv-restore-v2-publish-result/1', 'restoreId', p_restore_id,
      'state', 'QUARANTINED', 'published', false,
      'blockingReasons', jsonb_build_array('PUBLISH_TRANSACTION_ROLLED_BACK'),
      'credentialsRestored', 0
    );
  end;

  if exists (
    select 1 from private.rv2_credential_envelopes
  ) then
    raise exception 'credential restoration invariant failed' using errcode = 'P0001';
  end if;
  v_final_proof_sha256 := encode(extensions.digest(
    convert_to(p_journal_proof::text, 'utf8'), 'sha256'
  ), 'hex');
  update private.rv2_restore_v2_runs as r
     set state = 'PUBLISHED', blocking_reasons = array[]::text[],
         published_at = statement_timestamp(), updated_at = statement_timestamp(),
         journal_range_start = v_range_start,
         journal_range_end = v_range_end,
         journal_first_pass_root = p_journal_proof ->> 'firstPassRoot',
         journal_second_pass_root = p_journal_proof ->> 'secondPassRoot',
         journal_events = p_journal_proof -> 'events',
         effective_tenant_lineage_root = v_effective_root,
         journal_final_proof_sha256 = v_final_proof_sha256,
         journal_final_verified_at = statement_timestamp(),
         credentials_restored = 0
   where r.restore_id = p_restore_id
     and r.state in ('PUBLISHABLE', 'NOT_READY') and r.graph_verified;
  if not found then
    raise exception 'publish state conflict' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-publish-result/1', 'restoreId', p_restore_id,
    'state', 'PUBLISHED', 'published', true, 'idempotent', false,
    'credentialsRestored', 0, 'connectionState', 'RECONNECT_REQUIRED',
    'finalJournalProofVerified', true,
    'createdByRewrittenToRecoveredOwner', true
  );
end
$function$;

create function public.rv2_restore_v2_export_snapshot_rows()
returns table (row_ordinal bigint, row_data jsonb)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  perform private.rv2_require_service_role();
  perform public.rv2_restore_v2_prepare_lineage();
  -- One short, consistent export transaction for the invite-only ceiling of
  -- ten tenants. Writers wait until every ordered row is returned.
  lock table public.rv2_tenants, public.rv2_memberships, public.rv2_connections,
    public.rv2_source_events, public.rv2_generations,
    public.rv2_trade_identities, public.rv2_trade_read_models,
    public.rv2_reviews, public.rv2_actions, public.rv2_journal_entries,
    public.rv2_risk_rules, public.rv2_reports, public.rv2_ledger_generations,
    public.rv2_reconciliation_generations
    in share mode;
  lock table private.rv2_restore_v2_tenant_lineage,
    private.rv2_restore_v2_principal_lineage,
    private.rv2_restore_v2_connection_lineage,
    private.rv2_restore_v2_deletion_intents
    in share mode;
  -- A deletion event is journaled before data removal. Refuse a snapshot while
  -- any intent is between those two commits, otherwise its event time could
  -- precede the snapshot while the snapshot still contains the subject rows.
  if exists (
    select 1 from private.rv2_restore_v2_deletion_intents as i
     where i.state in ('PENDING_JOURNAL', 'JOURNALED')
  ) then
    raise exception 'deletion journal transition in progress' using errcode = '55000';
  end if;
  return query
  with raw_rows as (
    select 10 as dataset_order, t.tenant_id::text as stable_order,
      jsonb_build_object(
        'dataset', 'tenants', 'recordId', tl.tenant_lineage_id,
        'tenantLineageId', tl.tenant_lineage_id,
        'payload', jsonb_build_object(
          'status', t.status, 'createdAt', t.created_at
        )
      ) as row_data
      from public.rv2_tenants as t
      join private.rv2_restore_v2_tenant_lineage as tl
        on tl.source_tenant_id = t.tenant_id
     where t.status = 'ACTIVE'
    union all
    select 20, m.user_id::text,
      jsonb_build_object(
        'dataset', 'memberships', 'recordId', pl.principal_lineage_id,
        'tenantLineageId', pl.tenant_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'memberRole', m.member_role, 'status', m.status,
          'membershipVersion', m.membership_version,
          'recoveryTagHash', pl.recovery_tag_hash,
          'createdAt', m.created_at, 'updatedAt', m.updated_at
        )
      )
      from public.rv2_memberships as m
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = m.user_id
     where m.status = 'ACTIVE'
    union all
    select 30, c.connection_id::text,
      jsonb_build_object(
        'dataset', 'connections', 'recordId', cl.connection_lineage_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'provider', c.provider, 'providerScopeHash', c.provider_scope_hash,
          'consentVersion', c.consent_version,
          'currentGeneration', c.current_generation,
          'createdAt', c.created_at, 'updatedAt', c.updated_at
        )
      )
      from public.rv2_connections as c
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = c.connection_id
     where c.status <> 'REVOKED'
    union all
    select 40, e.event_id::text,
      jsonb_build_object(
        'dataset', 'source_events', 'recordId', e.event_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'eventId', e.event_id, 'syncJobId', e.sync_job_id,
          'dataset', e.dataset, 'providerEventId', e.provider_event_id,
          'eventTime', e.event_time, 'eventBody', e.event_body,
          'eventSha256', e.event_sha256,
          'sourceObservedAt', e.source_observed_at
        )
      )
      from public.rv2_source_events as e
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = e.connection_id
    union all
    select 50, g.generation_id::text,
      jsonb_build_object(
        'dataset', 'generations', 'recordId', g.generation_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'generation', g.generation, 'credentialVersion', g.credential_version,
          'sourceJobIds', to_jsonb(g.source_job_ids), 'coverage', g.coverage,
          'reconciliation', g.reconciliation, 'capabilities', g.capabilities,
          'sourceRootSha256', g.source_root_sha256,
          'sourceEventCount', g.source_event_count,
          'projectionSha256', g.projection_sha256,
          'tradeModelCount', g.trade_model_count,
          'manifestSha256', g.manifest_sha256, 'status', g.status,
          'publishedAt', g.published_at
        )
      )
      from public.rv2_generations as g
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = g.connection_id
    union all
    select 60, i.connection_id::text || ':' || i.trade_id,
      jsonb_build_object(
        'dataset', 'trade_identities',
        'recordId', private.rv2_restore_v2_uuid_from_text(
          i.tenant_id::text || ':' || i.connection_id::text || ':' || i.trade_id
        ),
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'tradeId', i.trade_id, 'idProtocol', i.id_protocol,
          'sourceLineageSha256', i.source_lineage_sha256,
          'firstGeneration', i.first_generation, 'firstSeenAt', i.first_seen_at
        )
      )
      from public.rv2_trade_identities as i
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = i.connection_id
    union all
    select 70, m.connection_id::text || ':' || m.trade_id || ':' || m.generation::text,
      jsonb_build_object(
        'dataset', 'trade_read_models',
        'recordId', private.rv2_restore_v2_uuid_from_text(
          m.tenant_id::text || ':' || m.connection_id::text || ':'
          || m.trade_id || ':' || m.generation::text
        ),
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'tradeId', m.trade_id, 'generation', m.generation,
          'modelProtocol', m.model_protocol, 'payload', m.payload,
          'payloadSha256', m.payload_sha256, 'projectedAt', m.projected_at
        )
      )
      from public.rv2_trade_read_models as m
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = m.connection_id
    union all
    select 80, r.review_id::text,
      jsonb_build_object(
        'dataset', 'reviews', 'recordId', r.review_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'tradeId', r.trade_id, 'tradeGeneration', r.trade_generation,
          'sourceLineageSha256', r.source_lineage_sha256,
          'version', r.version, 'payload', r.payload,
          'payloadSha256', r.payload_sha256,
          'createdAt', r.created_at, 'updatedAt', r.updated_at
        )
      )
      from public.rv2_reviews as r
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = r.connection_id
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = r.created_by
    union all
    select 90, a.action_id::text,
      jsonb_build_object(
        'dataset', 'actions', 'recordId', a.action_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'tradeId', a.trade_id, 'reviewLineageId', a.review_id,
          'status', a.status, 'version', a.version, 'payload', a.payload,
          'createdAt', a.created_at, 'updatedAt', a.updated_at
        )
      )
      from public.rv2_actions as a
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = a.connection_id
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = a.created_by
    union all
    select 100, j.journal_id::text,
      jsonb_build_object(
        'dataset', 'journal_entries', 'recordId', j.journal_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'journalDay', j.journal_day, 'version', j.version,
          'payload', j.payload, 'createdAt', j.created_at, 'updatedAt', j.updated_at
        )
      )
      from public.rv2_journal_entries as j
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = j.connection_id
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = j.created_by
    union all
    select 110, r.rule_id::text,
      jsonb_build_object(
        'dataset', 'risk_rules', 'recordId', r.rule_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'status', r.status, 'version', r.version, 'payload', r.payload,
          'createdAt', r.created_at, 'updatedAt', r.updated_at
        )
      )
      from public.rv2_risk_rules as r
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = r.connection_id
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = r.created_by
    union all
    select 120, r.report_id::text,
      jsonb_build_object(
        'dataset', 'reports', 'recordId', r.report_id,
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'principalLineageId', pl.principal_lineage_id,
        'payload', jsonb_build_object(
          'reportType', r.report_type, 'periodStart', r.period_start,
          'periodEnd', r.period_end, 'sourceGeneration', r.source_generation,
          'version', r.version, 'payload', r.payload,
          'payloadSha256', r.payload_sha256,
          'createdAt', r.created_at, 'updatedAt', r.updated_at
        )
      )
      from public.rv2_reports as r
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = r.connection_id
      join private.rv2_restore_v2_principal_lineage as pl
        on pl.source_user_id = r.created_by
    union all
    select 130, l.connection_id::text || ':' || l.generation::text,
      jsonb_build_object(
        'dataset', 'ledger_generations',
        'recordId', private.rv2_restore_v2_uuid_from_text(
          l.tenant_id::text || ':' || l.connection_id::text || ':ledger:' || l.generation::text
        ),
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'generation', l.generation, 'status', l.status,
          'projectionSha256', l.projection_sha256,
          'reasonCodes', to_jsonb(l.reason_codes),
          'createdAt', l.created_at, 'updatedAt', l.updated_at
        )
      )
      from public.rv2_ledger_generations as l
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = l.connection_id
    union all
    select 140, r.connection_id::text || ':' || r.generation::text,
      jsonb_build_object(
        'dataset', 'reconciliation_generations',
        'recordId', private.rv2_restore_v2_uuid_from_text(
          r.tenant_id::text || ':' || r.connection_id::text || ':reconcile:' || r.generation::text
        ),
        'tenantLineageId', cl.tenant_lineage_id,
        'connectionLineageId', cl.connection_lineage_id,
        'payload', jsonb_build_object(
          'generation', r.generation, 'state', r.state, 'status', r.status,
          'reasonCodes', to_jsonb(r.reason_codes), 'checks', r.checks,
          'createdAt', r.created_at, 'updatedAt', r.updated_at
        )
      )
      from public.rv2_reconciliation_generations as r
      join private.rv2_restore_v2_connection_lineage as cl
        on cl.source_connection_id = r.connection_id
  ), ordered as (
    select row_number() over (order by dataset_order, stable_order) - 1 as row_ordinal,
           raw_rows.row_data
      from raw_rows
  )
  select ordered.row_ordinal, ordered.row_data from ordered order by ordered.row_ordinal;
end
$function$;

create function private.rv2_restore_v2_materialize_backup_export(
  p_run_id text,
  p_run_attempt text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_export record;
  v_export_id uuid;
  v_row_count bigint;
  v_row_counts jsonb;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'restore v2 backup run rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-backup'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-restore-v2-backup:' || p_run_id || ':' || p_run_attempt, 0
  ));
  select e.* into v_export
    from private.rv2_restore_v2_backup_exports as e
   where e.run_id = p_run_id and e.run_attempt = p_run_attempt
   for update;
  if found then
    if v_export.status not in ('READY', 'SIGNED')
       or v_export.expires_at <= statement_timestamp() then
      raise exception 'restore v2 backup snapshot unavailable' using errcode = '55000';
    end if;
    return v_export.export_id;
  end if;

  insert into private.rv2_restore_v2_backup_exports (run_id, run_attempt)
  values (p_run_id, p_run_attempt)
  returning export_id into v_export_id;

  insert into private.rv2_restore_v2_backup_export_rows (
    export_id, row_ordinal, row_data, row_sha256
  )
  select v_export_id, exported.row_ordinal, exported.row_data,
         encode(extensions.digest(convert_to(exported.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_restore_v2_export_snapshot_rows() as exported;

  select coalesce(sum(counts.row_count), 0),
         coalesce(jsonb_object_agg(counts.dataset, counts.row_count), '{}'::jsonb)
    into v_row_count, v_row_counts
    from (
      select r.row_data ->> 'dataset' as dataset, count(*)::bigint as row_count
        from private.rv2_restore_v2_backup_export_rows as r
       where r.export_id = v_export_id
       group by r.row_data ->> 'dataset'
    ) as counts;
  if v_row_count <= 0
     or not (v_row_counts ?& array['tenants', 'memberships', 'connections']) then
    raise exception 'restore v2 backup lineage incomplete' using errcode = '55000';
  end if;
  update private.rv2_restore_v2_backup_exports as e
     set status = 'READY', row_count = v_row_count, row_counts = v_row_counts
   where e.export_id = v_export_id and e.status = 'MATERIALIZING';
  if not found then
    raise exception 'restore v2 backup snapshot conflict' using errcode = '40001';
  end if;
  return v_export_id;
end
$function$;

create function public.rv2_restore_v2_read_backup_page(
  p_run_id text,
  p_run_attempt text,
  p_cursor bigint,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_export_id uuid;
  v_export record;
  v_start bigint := coalesce(p_cursor, 0);
  v_rows jsonb;
  v_last bigint;
  v_next bigint;
begin
  perform private.rv2_require_service_role();
  if p_limit <> 250 or v_start < 0 then
    raise exception 'restore v2 backup page rejected' using errcode = '22023';
  end if;
  v_export_id := private.rv2_restore_v2_materialize_backup_export(p_run_id, p_run_attempt);
  select e.* into strict v_export
    from private.rv2_restore_v2_backup_exports as e
   where e.export_id = v_export_id and e.status in ('READY', 'SIGNED')
     and e.expires_at > statement_timestamp();

  select coalesce(jsonb_agg(jsonb_build_object(
           'rowOrdinal', page.row_ordinal,
           'rowData', page.row_data
         ) order by page.row_ordinal), '[]'::jsonb),
         max(page.row_ordinal)
    into v_rows, v_last
    from (
      select r.row_ordinal, r.row_data
        from private.rv2_restore_v2_backup_export_rows as r
       where r.export_id = v_export_id and r.row_ordinal >= v_start
       order by r.row_ordinal
       limit p_limit
    ) as page;
  if v_last is not null and exists (
    select 1 from private.rv2_restore_v2_backup_export_rows as remaining
     where remaining.export_id = v_export_id and remaining.row_ordinal > v_last
  ) then
    v_next := v_last + 1;
  else
    v_next := null;
  end if;
  return jsonb_build_object(
    'format', 'rv-restore-v2-export-page/1',
    'view', 'rv2_restore_export_v2',
    'readOnly', true,
    'snapshotId', v_export.export_id,
    'createdAt', to_char(v_export.snapshot_created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rowCount', v_export.row_count,
    'rowCounts', v_export.row_counts,
    'rows', v_rows,
    'nextCursor', v_next
  );
end
$function$;

create function public.rv2_restore_v2_record_backup_page_evidence(
  p_run_id text,
  p_run_attempt text,
  p_request_cursor bigint,
  p_page jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_expected jsonb;
  v_page_sha text;
  v_cursor_key text := coalesce(p_request_cursor::text, '__FIRST__');
  v_existing record;
begin
  perform private.rv2_require_service_role();
  if jsonb_typeof(p_page) <> 'object'
     or p_page ->> 'format' <> 'rv-restore-v2-export-page/1'
     or jsonb_typeof(p_page -> 'rows') <> 'array'
     or jsonb_array_length(p_page -> 'rows') > 250 then
    raise exception 'restore v2 backup page evidence rejected' using errcode = '22023';
  end if;
  v_expected := public.rv2_restore_v2_read_backup_page(
    p_run_id, p_run_attempt, p_request_cursor, 250
  );
  if v_expected <> p_page then
    raise exception 'restore v2 backup page evidence mismatch' using errcode = '40001';
  end if;
  v_page_sha := encode(extensions.digest(convert_to(p_page::text, 'utf8'), 'sha256'), 'hex');
  select e.* into v_existing
    from private.rv2_restore_v2_backup_page_evidence as e
   where e.export_id = (p_page ->> 'snapshotId')::uuid
     and e.request_cursor_key = v_cursor_key;
  if found then
    if v_existing.page_sha256 <> v_page_sha
       or v_existing.run_id <> p_run_id
       or v_existing.run_attempt <> p_run_attempt then
      raise exception 'restore v2 backup page replay conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('recorded', true, 'replayed', true);
  end if;
  insert into private.rv2_restore_v2_backup_page_evidence (
    export_id, run_id, run_attempt, request_cursor, request_cursor_key,
    next_cursor, row_count, page_sha256
  ) values (
    (p_page ->> 'snapshotId')::uuid, p_run_id, p_run_attempt,
    p_request_cursor, v_cursor_key,
    case when p_page ->> 'nextCursor' is null then null
      else (p_page ->> 'nextCursor')::bigint end,
    jsonb_array_length(p_page -> 'rows'), v_page_sha
  );
  return jsonb_build_object('recorded', true, 'replayed', false);
end
$function$;

create function public.rv2_restore_v2_claim_backup_signing_evidence(
  p_run_id text,
  p_run_attempt text,
  p_scope_prefix text,
  p_manifest jsonb,
  p_journal_proof jsonb,
  p_object_key text,
  p_object_bytes bigint,
  p_object_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_export record;
  v_existing record;
  v_manifest_sha text;
  v_journal_sha text;
  v_chain_pages bigint;
  v_evidence_pages bigint;
  v_evidence_rows bigint;
  v_terminal_pages bigint;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_key_count integer;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_scope_prefix <> 'beta-backups/runs/' || p_run_id
       || '/attempt-' || p_run_attempt || '/'
     or p_object_key not like p_scope_prefix || '%'
     or p_object_key ~ '(^|/)[.][.](/|$)'
     or p_object_bytes not between 1 and 1099511627776
     or p_object_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_journal_proof) <> 'object' then
    raise exception 'restore v2 backup signing rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-backup'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_manifest);
  if v_key_count <> 10
     or p_manifest ->> 'format' <> 'rv-restore-snapshot-manifest/2'
     or p_manifest ->> 'credentialsIncluded' <> 'false'
     or (p_manifest ->> 'snapshotId') !~ '^[0-9a-f-]{36}$'
     or (p_manifest ->> 'rowCount') !~ '^[1-9][0-9]{0,11}$'
     or jsonb_typeof(p_manifest -> 'rowCounts') <> 'object'
     or (p_manifest ->> 'orderedContentRoot') !~ '^[0-9a-f]{64}$'
     or (p_manifest ->> 'tenantLineageRoot') !~ '^[0-9a-f]{64}$'
     or (p_manifest ->> 'plaintextStreamSha256') !~ '^[0-9a-f]{64}$'
     or (p_manifest ->> 'externalJournalRoot') !~ '^[0-9a-f]{64}$' then
    raise exception 'restore v2 backup manifest rejected' using errcode = '22023';
  end if;
  begin
    v_range_start := (p_journal_proof ->> 'rangeStart')::timestamptz;
    v_range_end := (p_journal_proof ->> 'rangeEnd')::timestamptz;
  exception when others then
    raise exception 'restore v2 backup journal proof rejected' using errcode = '22023';
  end;
  if p_journal_proof ->> 'format' <> 'rv-deletion-journal-range-proof/2'
     or (p_journal_proof ->> 'firstPassRoot') !~ '^[0-9a-f]{64}$'
     or p_journal_proof ->> 'secondPassRoot' <> p_journal_proof ->> 'firstPassRoot'
     or p_journal_proof ->> 'snapshotJournalRoot'
       <> p_manifest ->> 'externalJournalRoot' then
    raise exception 'restore v2 backup journal proof rejected' using errcode = '22023';
  end if;
  select e.* into v_export
    from private.rv2_restore_v2_backup_exports as e
   where e.export_id = (p_manifest ->> 'snapshotId')::uuid
     and e.run_id = p_run_id and e.run_attempt = p_run_attempt
     and e.status = 'READY' and e.expires_at > statement_timestamp()
   for update;
  if not found
     or v_export.row_count <> (p_manifest ->> 'rowCount')::bigint
     or v_export.row_counts <> p_manifest -> 'rowCounts'
     or to_char(v_export.snapshot_created_at at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_manifest ->> 'createdAt'
     or v_range_start > v_export.snapshot_created_at
     or v_range_end < v_export.snapshot_created_at then
    raise exception 'restore v2 backup snapshot evidence mismatch' using errcode = '40001';
  end if;

  with recursive chain as (
    select e.request_cursor_key, e.next_cursor, e.row_count,
           array[e.request_cursor_key]::text[] as visited
      from private.rv2_restore_v2_backup_page_evidence as e
     where e.export_id = v_export.export_id
       and e.run_id = p_run_id and e.run_attempt = p_run_attempt
       and e.request_cursor_key = '__FIRST__'
    union all
    select e.request_cursor_key, e.next_cursor, e.row_count,
           chain.visited || e.request_cursor_key
      from chain
      join private.rv2_restore_v2_backup_page_evidence as e
        on e.export_id = v_export.export_id
       and e.run_id = p_run_id and e.run_attempt = p_run_attempt
       and e.request_cursor_key = chain.next_cursor::text
     where chain.next_cursor is not null
       and not e.request_cursor_key = any(chain.visited)
  )
  select count(*), coalesce(sum(row_count), 0),
         count(*) filter (where next_cursor is null)
    into v_chain_pages, v_evidence_rows, v_terminal_pages
    from chain;
  select count(*) into v_evidence_pages
    from private.rv2_restore_v2_backup_page_evidence as e
   where e.export_id = v_export.export_id
     and e.run_id = p_run_id and e.run_attempt = p_run_attempt;
  if v_chain_pages = 0 or v_chain_pages <> v_evidence_pages
     or v_terminal_pages <> 1 or v_evidence_rows <> v_export.row_count then
    raise exception 'restore v2 backup page chain incomplete' using errcode = '55000';
  end if;
  v_manifest_sha := encode(extensions.digest(convert_to(p_manifest::text, 'utf8'), 'sha256'), 'hex');
  v_journal_sha := encode(extensions.digest(convert_to(p_journal_proof::text, 'utf8'), 'sha256'), 'hex');
  select c.* into v_existing
    from private.rv2_restore_v2_backup_signing_claims as c
   where c.run_id = p_run_id and c.run_attempt = p_run_attempt;
  if found then
    if v_existing.export_id <> v_export.export_id
       or v_existing.manifest_sha256 <> v_manifest_sha
       or v_existing.journal_proof_sha256 <> v_journal_sha
       or v_existing.object_key <> p_object_key
       or v_existing.object_bytes <> p_object_bytes
       or v_existing.object_sha256 <> p_object_sha256 then
      raise exception 'restore v2 backup signing replay conflict' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'verified', true, 'claimed', false, 'firstUse', false,
      'manifestSha256', v_manifest_sha
    );
  end if;
  insert into private.rv2_restore_v2_backup_signing_claims (
    export_id, run_id, run_attempt, manifest_sha256, journal_proof_sha256,
    scope_prefix, object_key, object_bytes, object_sha256
  ) values (
    v_export.export_id, p_run_id, p_run_attempt, v_manifest_sha, v_journal_sha,
    p_scope_prefix, p_object_key, p_object_bytes, p_object_sha256
  );
  update private.rv2_restore_v2_backup_exports as e
     set status = 'SIGNED', signed_at = statement_timestamp()
   where e.export_id = v_export.export_id and e.status = 'READY';
  if not found then
    raise exception 'restore v2 backup signing state conflict' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'verified', true, 'claimed', true, 'firstUse', true,
    'manifestSha256', v_manifest_sha
  );
end
$function$;

-- No direct Data API table access. Even service_role reaches the restore plane
-- only through the narrow SECURITY DEFINER RPCs below.
alter table private.rv2_restore_v2_tenant_lineage enable row level security;
alter table private.rv2_restore_v2_tenant_lineage force row level security;
alter table private.rv2_restore_v2_principal_lineage enable row level security;
alter table private.rv2_restore_v2_principal_lineage force row level security;
alter table private.rv2_restore_v2_connection_lineage enable row level security;
alter table private.rv2_restore_v2_connection_lineage force row level security;
alter table private.rv2_restore_v2_deletion_intents enable row level security;
alter table private.rv2_restore_v2_deletion_intents force row level security;
alter table private.rv2_restore_v2_deletion_evidence enable row level security;
alter table private.rv2_restore_v2_deletion_evidence force row level security;
alter table private.rv2_restore_v2_snapshots enable row level security;
alter table private.rv2_restore_v2_snapshots force row level security;
alter table private.rv2_restore_v2_runs enable row level security;
alter table private.rv2_restore_v2_runs force row level security;
alter table private.rv2_restore_v2_batches enable row level security;
alter table private.rv2_restore_v2_batches force row level security;
alter table private.rv2_restore_v2_staging_rows enable row level security;
alter table private.rv2_restore_v2_staging_rows force row level security;
alter table private.rv2_restore_v2_owner_claims enable row level security;
alter table private.rv2_restore_v2_owner_claims force row level security;
alter table private.rv2_restore_v2_tenant_maps enable row level security;
alter table private.rv2_restore_v2_tenant_maps force row level security;
alter table private.rv2_restore_v2_connection_maps enable row level security;
alter table private.rv2_restore_v2_connection_maps force row level security;
alter table private.rv2_restore_v2_backup_exports enable row level security;
alter table private.rv2_restore_v2_backup_exports force row level security;
alter table private.rv2_restore_v2_backup_export_rows enable row level security;
alter table private.rv2_restore_v2_backup_export_rows force row level security;
alter table private.rv2_restore_v2_backup_page_evidence enable row level security;
alter table private.rv2_restore_v2_backup_page_evidence force row level security;
alter table private.rv2_restore_v2_backup_signing_claims enable row level security;
alter table private.rv2_restore_v2_backup_signing_claims force row level security;

revoke all privileges on table private.rv2_restore_v2_tenant_lineage from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_principal_lineage from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_connection_lineage from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_deletion_intents from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_deletion_evidence from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_snapshots from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_runs from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_batches from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_staging_rows from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_owner_claims from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_tenant_maps from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_connection_maps from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_backup_exports from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_backup_export_rows from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_backup_page_evidence from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_restore_v2_backup_signing_claims from public, anon, authenticated, service_role;

revoke all on function private.rv2_restore_v2_pepper() from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_uuid_from_text(text) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_deletion_event_object_text(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_journal_proof_is_valid(jsonb, timestamptz, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_recovery_tag(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_project_is_empty() from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_stage_row_is_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_owner_for_tenant(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rv2_restore_v2_materialize_backup_export(text, text) from public, anon, authenticated, service_role;

revoke all on function public.rv2_restore_v2_prepare_lineage() from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_verified_recovery_tag(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_create_deletion_intent(uuid, uuid, bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_prepare_public_deletion(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_attest_deletion_journal(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_execute_deletion(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_claim_restore(jsonb, text, boolean, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_stage_batch(uuid, integer, integer, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_issue_owner_invite(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_claim_owner(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_recover_owner_by_verified_subject(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_publish(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_export_snapshot_rows() from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_read_backup_page(text, text, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_record_backup_page_evidence(text, text, bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_restore_v2_claim_backup_signing_evidence(text, text, text, jsonb, jsonb, text, bigint, text) from public, anon, authenticated, service_role;

grant execute on function public.rv2_restore_v2_prepare_lineage() to service_role;
grant execute on function public.rv2_restore_v2_verified_recovery_tag(uuid) to service_role;
grant execute on function public.rv2_restore_v2_create_deletion_intent(uuid, uuid, bigint, text, uuid) to service_role;
grant execute on function public.rv2_restore_v2_prepare_public_deletion(uuid, uuid, text) to service_role;
grant execute on function public.rv2_restore_v2_attest_deletion_journal(uuid, jsonb, jsonb) to service_role;
grant execute on function public.rv2_restore_v2_execute_deletion(uuid) to service_role;
grant execute on function public.rv2_restore_v2_claim_restore(jsonb, text, boolean, jsonb) to service_role;
grant execute on function public.rv2_restore_v2_stage_batch(uuid, integer, integer, uuid, jsonb) to service_role;
grant execute on function public.rv2_restore_v2_issue_owner_invite(uuid, uuid, uuid) to service_role;
grant execute on function public.rv2_restore_v2_claim_owner(uuid, uuid, text, uuid) to service_role;
grant execute on function public.rv2_restore_v2_recover_owner_by_verified_subject(uuid, uuid) to service_role;
grant execute on function public.rv2_restore_v2_status(uuid) to service_role;
grant execute on function public.rv2_restore_v2_publish(uuid, jsonb) to service_role;
grant execute on function public.rv2_restore_v2_export_snapshot_rows() to service_role;
grant execute on function public.rv2_restore_v2_read_backup_page(text, text, bigint, integer) to service_role;
grant execute on function public.rv2_restore_v2_record_backup_page_evidence(text, text, bigint, jsonb) to service_role;
grant execute on function public.rv2_restore_v2_claim_backup_signing_evidence(text, text, text, jsonb, jsonb, text, bigint, text) to service_role;

alter function private.rv2_restore_v2_pepper() owner to postgres;
alter function private.rv2_restore_v2_uuid_from_text(text) owner to postgres;
alter function private.rv2_restore_v2_deletion_event_object_text(jsonb) owner to postgres;
alter function private.rv2_restore_v2_journal_proof_is_valid(jsonb, timestamptz, text, timestamptz) owner to postgres;
alter function private.rv2_restore_v2_recovery_tag(text, uuid) owner to postgres;
alter function private.rv2_restore_v2_project_is_empty() owner to postgres;
alter function private.rv2_restore_v2_stage_row_is_valid(jsonb) owner to postgres;
alter function private.rv2_restore_v2_owner_for_tenant(uuid, uuid) owner to postgres;
alter function private.rv2_restore_v2_materialize_backup_export(text, text) owner to postgres;
alter function public.rv2_restore_v2_prepare_lineage() owner to postgres;
alter function public.rv2_restore_v2_verified_recovery_tag(uuid) owner to postgres;
alter function public.rv2_restore_v2_create_deletion_intent(uuid, uuid, bigint, text, uuid) owner to postgres;
alter function public.rv2_restore_v2_prepare_public_deletion(uuid, uuid, text) owner to postgres;
alter function public.rv2_restore_v2_attest_deletion_journal(uuid, jsonb, jsonb) owner to postgres;
alter function public.rv2_restore_v2_execute_deletion(uuid) owner to postgres;
alter function public.rv2_restore_v2_claim_restore(jsonb, text, boolean, jsonb) owner to postgres;
alter function public.rv2_restore_v2_stage_batch(uuid, integer, integer, uuid, jsonb) owner to postgres;
alter function public.rv2_restore_v2_issue_owner_invite(uuid, uuid, uuid) owner to postgres;
alter function public.rv2_restore_v2_claim_owner(uuid, uuid, text, uuid) owner to postgres;
alter function public.rv2_restore_v2_recover_owner_by_verified_subject(uuid, uuid) owner to postgres;
alter function public.rv2_restore_v2_status(uuid) owner to postgres;
alter function public.rv2_restore_v2_publish(uuid, jsonb) owner to postgres;
alter function public.rv2_restore_v2_export_snapshot_rows() owner to postgres;
alter function public.rv2_restore_v2_read_backup_page(text, text, bigint, integer) owner to postgres;
alter function public.rv2_restore_v2_record_backup_page_evidence(text, text, bigint, jsonb) owner to postgres;
alter function public.rv2_restore_v2_claim_backup_signing_evidence(text, text, text, jsonb, jsonb, text, bigint, text) owner to postgres;

-- Local contract readiness is not a live disaster-recovery attestation. A real
-- empty-project restore, verified SMTP recovery invites, private R2 policies,
-- key custody, and a successful Tokyo recovery drill remain release gates.

commit;

-- Review Workbench invite-only Beta rv2 data plane.
--
-- Forward-only and additive: the prior encrypted vault remains readable and
-- deletable, while its browser mutation RPCs are retired before rv2 is exposed.

begin;

create extension if not exists pg_net with schema extensions;

do $preflight$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.workspaces') is null
     or to_regclass('private.rv_rate_limit_buckets') is null then
    raise exception 'rv2 requires the complete production-vault migration chain'
      using errcode = 'P0001';
  end if;
end
$preflight$;

create table public.rv2_tenants (
  tenant_id uuid not null default gen_random_uuid(),
  status text not null default 'ACTIVE',
  deletion_receipt_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  deleted_at timestamptz,
  constraint rv2_tenants_pkey primary key (tenant_id),
  constraint rv2_tenants_status_check check (status in ('ACTIVE', 'DELETED')),
  constraint rv2_tenants_delete_state_check check (
    (status = 'ACTIVE' and deletion_receipt_id is null and deleted_at is null)
    or (status = 'DELETED' and deletion_receipt_id is not null and deleted_at is not null)
  )
);

create table public.rv2_memberships (
  tenant_id uuid not null,
  user_id uuid not null,
  member_role text not null default 'OWNER',
  status text not null default 'ACTIVE',
  membership_version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_memberships_pkey primary key (tenant_id, user_id),
  constraint rv2_memberships_tenant_key unique (tenant_id),
  constraint rv2_memberships_user_key unique (user_id),
  constraint rv2_memberships_tenant_fkey foreign key (tenant_id)
    references public.rv2_tenants (tenant_id) on delete cascade,
  constraint rv2_memberships_user_fkey foreign key (user_id)
    references auth.users (id) on delete cascade,
  constraint rv2_memberships_role_check check (member_role = 'OWNER'),
  constraint rv2_memberships_status_check check (status in ('ACTIVE', 'DISABLED', 'DELETED')),
  constraint rv2_memberships_version_check check (membership_version > 0)
);

create function private.rv2_enforce_personal_membership_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'INSERT' then
    if new.member_role <> 'OWNER'
       or not exists (
         select 1 from public.rv2_tenants as t
          where t.tenant_id = new.tenant_id and t.status = 'ACTIVE'
       ) then
      raise exception 'personal tenant ownership is unavailable' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.tenant_id <> old.tenant_id
       or new.user_id <> old.user_id
       or new.member_role <> 'OWNER'
       or new.member_role <> old.member_role) then
    raise exception 'personal tenant ownership is immutable' using errcode = '23514';
  end if;
  if tg_op = 'DELETE'
     and exists (
       select 1 from public.rv2_tenants as t
        where t.tenant_id = old.tenant_id and t.status <> 'DELETED'
     ) then
    raise exception 'personal tenant membership cannot be detached' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

create trigger rv2_memberships_personal_identity
before insert or update of tenant_id, user_id, member_role or delete on public.rv2_memberships
for each row execute function private.rv2_enforce_personal_membership_identity();

create function private.rv2_permission_evidence_is_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_key_count integer;
  v_checked_at timestamptz;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    return false;
  end if;
  if not (p_value ?& array[
    'evidenceVersion', 'provider', 'readOnly', 'tradeDisabled', 'withdrawDisabled',
    'internalTransferDisabled', 'universalTransferDisabled',
    'checkedAt', 'evidenceDigest'
  ]) then
    return false;
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_value);
  if v_key_count <> 9
     or p_value ->> 'evidenceVersion' <> 'rv-binance-permission/1'
     or p_value ->> 'provider' <> 'binance-usdm'
     or jsonb_typeof(p_value -> 'readOnly') <> 'boolean'
     or jsonb_typeof(p_value -> 'tradeDisabled') <> 'boolean'
     or jsonb_typeof(p_value -> 'withdrawDisabled') <> 'boolean'
     or jsonb_typeof(p_value -> 'internalTransferDisabled') <> 'boolean'
     or jsonb_typeof(p_value -> 'universalTransferDisabled') <> 'boolean'
     or jsonb_typeof(p_value -> 'checkedAt') <> 'string'
     or jsonb_typeof(p_value -> 'evidenceDigest') <> 'string'
     or (p_value ->> 'checkedAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
     or (p_value ->> 'evidenceDigest') !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  begin
    v_checked_at := (p_value ->> 'checkedAt')::timestamptz;
  exception when others then
    return false;
  end;
  return true;
end
$function$;

create table public.rv2_connections (
  tenant_id uuid not null,
  connection_id uuid not null default gen_random_uuid(),
  provider text not null,
  provider_scope_hash text not null,
  credential_version bigint not null default 1,
  status text not null default 'VERIFYING',
  permission_state text not null default 'UNKNOWN',
  permission_evidence jsonb,
  consent_version text not null,
  verified_at timestamptz,
  last_trusted_at timestamptz,
  next_due_at timestamptz,
  last_error_code text,
  current_generation bigint not null default 0,
  disconnect_receipt_id uuid,
  disconnected_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_connections_pkey primary key (connection_id),
  constraint rv2_connections_tenant_connection_key unique (tenant_id, connection_id),
  constraint rv2_connections_scope_key unique (tenant_id, provider, provider_scope_hash),
  constraint rv2_connections_tenant_fkey foreign key (tenant_id)
    references public.rv2_tenants (tenant_id) on delete cascade,
  constraint rv2_connections_provider_check check (provider = 'binance'),
  constraint rv2_connections_scope_hash_check check (provider_scope_hash ~ '^[0-9a-f]{64}$'),
  constraint rv2_connections_credential_version_check check (credential_version > 0),
  constraint rv2_connections_status_check check (
    status in ('VERIFYING', 'ACTIVE', 'AUTH_ERROR', 'RATE_LIMITED', 'DISABLED', 'REVOKED')
  ),
  constraint rv2_connections_consent_check check (
    consent_version = 'rv-binance-beta-consent/1'
  ),
  constraint rv2_connections_permission_state_check check (
    permission_state in ('UNKNOWN', 'READ_ONLY_VERIFIED', 'INSUFFICIENT', 'FAILED')
  ),
  constraint rv2_connections_permission_evidence_check check (
    (permission_state = 'UNKNOWN' and permission_evidence is null)
    or (permission_state <> 'UNKNOWN' and private.rv2_permission_evidence_is_valid(permission_evidence))
  ),
  constraint rv2_connections_active_permission_check check (
    status <> 'ACTIVE' or permission_state = 'READ_ONLY_VERIFIED'
  ),
  constraint rv2_connections_read_only_evidence_check check (
    permission_state <> 'READ_ONLY_VERIFIED'
    or (
      (permission_evidence ->> 'readOnly')::boolean
      and (permission_evidence ->> 'tradeDisabled')::boolean
      and (permission_evidence ->> 'withdrawDisabled')::boolean
      and (permission_evidence ->> 'internalTransferDisabled')::boolean
      and (permission_evidence ->> 'universalTransferDisabled')::boolean
    )
  ),
  constraint rv2_connections_generation_check check (current_generation >= 0),
  constraint rv2_connections_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint rv2_connections_disconnect_state_check check (
    (status <> 'REVOKED' and disconnect_receipt_id is null and disconnected_at is null)
    or (status = 'REVOKED' and disconnect_receipt_id is not null and disconnected_at is not null)
  )
);

create table public.rv2_source_events (
  tenant_id uuid not null,
  connection_id uuid not null,
  event_id uuid not null default gen_random_uuid(),
  sync_job_id uuid not null,
  dataset text not null,
  provider_event_id text not null,
  event_time timestamptz not null,
  event_body jsonb not null,
  event_sha256 text not null,
  source_observed_at timestamptz not null default statement_timestamp(),
  constraint rv2_source_events_pkey primary key (event_id),
  constraint rv2_source_events_tenant_event_key unique (tenant_id, connection_id, event_id),
  constraint rv2_source_events_provider_key
    unique (tenant_id, connection_id, dataset, provider_event_id),
  constraint rv2_source_events_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_source_events_dataset_check check (
    dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
  ),
  constraint rv2_source_events_provider_id_check check (
    length(provider_event_id) between 1 and 192
    and provider_event_id !~ '[[:cntrl:]]'
  ),
  constraint rv2_source_events_body_check check (
    jsonb_typeof(event_body) = 'object' and octet_length(event_body::text) <= 65536
  ),
  constraint rv2_source_events_sha_check check (event_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.rv2_generations (
  tenant_id uuid not null,
  connection_id uuid not null,
  generation bigint not null,
  generation_id uuid not null default gen_random_uuid(),
  credential_version bigint not null,
  source_job_ids uuid[] not null,
  coverage jsonb not null,
  reconciliation jsonb not null,
  capabilities jsonb not null,
  source_root_sha256 text not null,
  source_event_count bigint not null,
  projection_sha256 text not null,
  trade_model_count bigint not null,
  manifest_sha256 text not null,
  status text not null default 'PUBLISHED',
  published_at timestamptz not null default statement_timestamp(),
  constraint rv2_generations_pkey primary key (tenant_id, connection_id, generation),
  constraint rv2_generations_id_key unique (generation_id),
  constraint rv2_generations_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_generations_generation_check check (generation > 0),
  constraint rv2_generations_credential_check check (credential_version > 0),
  constraint rv2_generations_jobs_check check (
    cardinality(source_job_ids) between 1 and 128
  ),
  constraint rv2_generations_source_root_check
    check (source_root_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_generations_source_count_check check (source_event_count >= 0),
  constraint rv2_generations_projection_sha_check
    check (projection_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_generations_model_count_check check (trade_model_count >= 0),
  constraint rv2_generations_manifest_sha_check check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_generations_status_check check (status in ('PUBLISHED', 'SUPERSEDED', 'REVOKED'))
);

create table public.rv2_trade_identities (
  tenant_id uuid not null,
  connection_id uuid not null,
  trade_id text not null,
  id_protocol text not null default 'rv2-trade-id/1',
  source_lineage_sha256 text not null,
  first_generation bigint not null,
  first_seen_at timestamptz not null default statement_timestamp(),
  constraint rv2_trade_identities_pkey primary key (tenant_id, connection_id, trade_id),
  constraint rv2_trade_identities_lineage_key
    unique (tenant_id, connection_id, source_lineage_sha256),
  constraint rv2_trade_identities_trade_lineage_key
    unique (tenant_id, connection_id, trade_id, source_lineage_sha256),
  constraint rv2_trade_identities_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_trade_identities_generation_fkey
    foreign key (tenant_id, connection_id, first_generation)
    references public.rv2_generations (tenant_id, connection_id, generation),
  constraint rv2_trade_identities_trade_id_check check (trade_id ~ '^t_[0-9a-f]{16}$'),
  constraint rv2_trade_identities_protocol_check check (id_protocol = 'rv2-trade-id/1'),
  constraint rv2_trade_identities_lineage_sha_check
    check (source_lineage_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_trade_identities_generation_check check (first_generation > 0)
);

create table public.rv2_trade_read_models (
  tenant_id uuid not null,
  connection_id uuid not null,
  trade_id text not null,
  generation bigint not null,
  model_protocol text not null default 'rv2-trade-read-model/1',
  payload jsonb not null,
  payload_sha256 text not null,
  projected_at timestamptz not null default statement_timestamp(),
  constraint rv2_trade_read_models_pkey
    primary key (tenant_id, connection_id, trade_id, generation),
  constraint rv2_trade_read_models_identity_fkey
    foreign key (tenant_id, connection_id, trade_id)
    references public.rv2_trade_identities (tenant_id, connection_id, trade_id) on delete cascade,
  constraint rv2_trade_read_models_generation_fkey
    foreign key (tenant_id, connection_id, generation)
    references public.rv2_generations (tenant_id, connection_id, generation) on delete cascade,
  constraint rv2_trade_read_models_protocol_check check (model_protocol = 'rv2-trade-read-model/1'),
  constraint rv2_trade_read_models_generation_check check (generation > 0),
  constraint rv2_trade_read_models_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192
  ),
  constraint rv2_trade_read_models_payload_sha_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.rv2_reviews (
  tenant_id uuid not null,
  connection_id uuid not null,
  review_id uuid not null default gen_random_uuid(),
  trade_id text not null,
  trade_generation bigint not null,
  source_lineage_sha256 text not null,
  version bigint not null default 1,
  payload jsonb not null,
  payload_sha256 text not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_reviews_pkey primary key (review_id),
  constraint rv2_reviews_tenant_review_key unique (tenant_id, connection_id, review_id),
  constraint rv2_reviews_review_trade_key
    unique (tenant_id, connection_id, review_id, trade_id),
  constraint rv2_reviews_trade_key unique (tenant_id, connection_id, trade_id),
  constraint rv2_reviews_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_reviews_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_reviews_trade_model_fkey
    foreign key (tenant_id, connection_id, trade_id, trade_generation)
    references public.rv2_trade_read_models
      (tenant_id, connection_id, trade_id, generation),
  constraint rv2_reviews_trade_identity_fkey
    foreign key (tenant_id, connection_id, trade_id, source_lineage_sha256)
    references public.rv2_trade_identities
      (tenant_id, connection_id, trade_id, source_lineage_sha256),
  constraint rv2_reviews_trade_id_check check (trade_id ~ '^t_[0-9a-f]{16}$'),
  constraint rv2_reviews_generation_check check (trade_generation > 0),
  constraint rv2_reviews_lineage_sha_check
    check (source_lineage_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_reviews_version_check check (version > 0),
  constraint rv2_reviews_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536
  ),
  constraint rv2_reviews_payload_sha_check check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.rv2_actions (
  tenant_id uuid not null,
  connection_id uuid not null,
  action_id uuid not null default gen_random_uuid(),
  review_id uuid not null,
  trade_id text not null,
  status text not null default 'OPEN',
  version bigint not null default 1,
  payload jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_actions_pkey primary key (action_id),
  constraint rv2_actions_review_key unique (tenant_id, connection_id, review_id),
  constraint rv2_actions_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_actions_review_fkey
    foreign key (tenant_id, connection_id, review_id, trade_id)
    references public.rv2_reviews
      (tenant_id, connection_id, review_id, trade_id) on delete cascade,
  constraint rv2_actions_trade_fkey foreign key (tenant_id, connection_id, trade_id)
    references public.rv2_trade_identities (tenant_id, connection_id, trade_id),
  constraint rv2_actions_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_actions_status_check check (status in ('OPEN', 'DONE', 'CANCELLED')),
  constraint rv2_actions_trade_id_check check (trade_id ~ '^t_[0-9a-f]{16}$'),
  constraint rv2_actions_version_check check (version > 0),
  constraint rv2_actions_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536
  )
);

create table public.rv2_journal_entries (
  tenant_id uuid not null,
  connection_id uuid not null,
  journal_id uuid not null default gen_random_uuid(),
  journal_day date not null,
  version bigint not null default 1,
  payload jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_journal_entries_pkey primary key (journal_id),
  constraint rv2_journal_entries_day_key unique (tenant_id, connection_id, journal_day),
  constraint rv2_journal_entries_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_journal_entries_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_journal_entries_version_check check (version > 0),
  constraint rv2_journal_entries_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536
  )
);

create table public.rv2_risk_rules (
  tenant_id uuid not null,
  connection_id uuid not null,
  rule_id uuid not null default gen_random_uuid(),
  status text not null default 'ACTIVE',
  version bigint not null default 1,
  payload jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_risk_rules_pkey primary key (rule_id),
  constraint rv2_risk_rules_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_risk_rules_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_risk_rules_status_check check (status in ('ACTIVE', 'PAUSED', 'RETIRED')),
  constraint rv2_risk_rules_version_check check (version > 0),
  constraint rv2_risk_rules_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536
  )
);

create table public.rv2_reports (
  tenant_id uuid not null,
  connection_id uuid not null,
  report_id uuid not null default gen_random_uuid(),
  report_type text not null,
  period_start date not null,
  period_end date not null,
  source_generation bigint not null,
  version bigint not null default 1,
  payload jsonb not null,
  payload_sha256 text not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_reports_pkey primary key (report_id),
  constraint rv2_reports_period_key unique (
    tenant_id, connection_id, report_type, period_start, period_end
  ),
  constraint rv2_reports_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_reports_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_reports_type_check check (report_type in ('WEEKLY', 'MONTHLY')),
  constraint rv2_reports_period_check check (period_start <= period_end),
  constraint rv2_reports_generation_check check (source_generation > 0),
  constraint rv2_reports_version_check check (version > 0),
  constraint rv2_reports_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144
  ),
  constraint rv2_reports_payload_sha_check check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.rv2_ledger_generations (
  tenant_id uuid not null,
  connection_id uuid not null,
  generation bigint not null,
  status text not null default 'SHADOW_PENDING',
  projection_sha256 text,
  reason_codes text[] not null default array[]::text[],
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_ledger_generations_pkey primary key (tenant_id, connection_id, generation),
  constraint rv2_ledger_generations_generation_fkey
    foreign key (tenant_id, connection_id, generation)
    references public.rv2_generations (tenant_id, connection_id, generation) on delete cascade,
  constraint rv2_ledger_generations_status_check
    check (status in ('SHADOW_PENDING', 'SHADOW_READY', 'SHADOW_FAILED', 'SUPERSEDED')),
  constraint rv2_ledger_generations_sha_check check (
    projection_sha256 is null or projection_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table public.rv2_reconciliation_generations (
  tenant_id uuid not null,
  connection_id uuid not null,
  generation bigint not null,
  state text not null default 'PENDING',
  status text not null default 'UNKNOWN',
  reason_codes text[] not null default array[]::text[],
  checks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_reconciliation_generations_pkey primary key (tenant_id, connection_id, generation),
  constraint rv2_reconciliation_generations_generation_fkey
    foreign key (tenant_id, connection_id, generation)
    references public.rv2_generations (tenant_id, connection_id, generation) on delete cascade,
  constraint rv2_reconciliation_generations_state_check
    check (state in ('PENDING', 'RUNNING', 'FINAL', 'SUPERSEDED')),
  constraint rv2_reconciliation_generations_status_check
    check (status in ('PASS', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT')),
  constraint rv2_reconciliation_generations_checks_check check (
    jsonb_typeof(checks) = 'object' and octet_length(checks::text) <= 65536
  )
);

create table private.rv2_credential_envelopes (
  tenant_id uuid not null,
  connection_id uuid not null,
  credential_version bigint not null,
  operation text not null,
  envelope_ciphertext text not null,
  envelope_nonce text not null,
  envelope_key_ref text not null,
  envelope_sha256 text not null,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  permission_state text not null,
  permission_evidence jsonb not null,
  consent_version text not null,
  result_status text not null,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default statement_timestamp(),
  retired_at timestamptz,
  constraint rv2_credential_envelopes_pkey
    primary key (tenant_id, connection_id, credential_version),
  constraint rv2_credential_envelopes_idempotency_key
    unique (tenant_id, operation, idempotency_key),
  constraint rv2_credential_envelopes_connection_fkey
    foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_credential_envelopes_member_fkey
    foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id) on delete set null (created_by),
  constraint rv2_credential_envelopes_version_check check (credential_version > 0),
  constraint rv2_credential_envelopes_operation_check check (operation in ('CREATE', 'ROTATE')),
  constraint rv2_credential_envelopes_ciphertext_check check (
    length(envelope_ciphertext) between 32 and 32768
    and envelope_ciphertext ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint rv2_credential_envelopes_nonce_check check (envelope_nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  constraint rv2_credential_envelopes_key_ref_check check (
    length(envelope_key_ref) between 1 and 128 and envelope_key_ref ~ '^[A-Za-z0-9._:/-]+$'
  ),
  constraint rv2_credential_envelopes_sha_check check (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_credential_envelopes_request_check check (request_fingerprint ~ '^[0-9a-f]{64}$')
  ,constraint rv2_credential_envelopes_permission_state_check check (
    permission_state in ('READ_ONLY_VERIFIED', 'INSUFFICIENT', 'FAILED')
  )
  ,constraint rv2_credential_envelopes_permission_evidence_check check (
    private.rv2_permission_evidence_is_valid(permission_evidence)
  )
  ,constraint rv2_credential_envelopes_result_status_check check (
    result_status in ('ACTIVE', 'DISABLED')
  )
  ,constraint rv2_credential_envelopes_consent_check check (
    consent_version = 'rv-binance-beta-consent/1'
  )
);

create table private.rv2_sync_jobs (
  tenant_id uuid not null,
  job_id uuid not null default gen_random_uuid(),
  connection_id uuid not null,
  credential_version bigint not null,
  requested_by uuid not null,
  dataset text not null,
  partition_key text not null,
  queue_class text not null default 'INTERACTIVE',
  status text not null default 'QUEUED',
  page_committed boolean not null default false,
  page_cursor jsonb not null default '{}'::jsonb,
  page_number bigint not null default 0,
  previous_page_digest text,
  sync_complete boolean not null default false,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  attempt_count integer not null default 0,
  failure_count integer not null default 0,
  worker_subject uuid,
  claim_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz not null default statement_timestamp(),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_sync_jobs_pkey primary key (job_id),
  constraint rv2_sync_jobs_tenant_job_key unique (tenant_id, job_id),
  constraint rv2_sync_jobs_idempotency_key unique (tenant_id, idempotency_key),
  constraint rv2_sync_jobs_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_sync_jobs_credential_fkey
    foreign key (tenant_id, connection_id, credential_version)
    references private.rv2_credential_envelopes (tenant_id, connection_id, credential_version),
  constraint rv2_sync_jobs_member_fkey foreign key (tenant_id, requested_by)
    references public.rv2_memberships (tenant_id, user_id) on delete cascade,
  constraint rv2_sync_jobs_dataset_check check (
    dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
  ),
  constraint rv2_sync_jobs_partition_check check (
    length(partition_key) between 1 and 128 and partition_key ~ '^[A-Za-z0-9._:/-]+$'
  ),
  constraint rv2_sync_jobs_queue_check check (queue_class in ('INTERACTIVE', 'SCHEDULED')),
  constraint rv2_sync_jobs_status_check check (
    status in ('QUEUED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  constraint rv2_sync_jobs_request_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint rv2_sync_jobs_attempt_check check (attempt_count between 0 and 10000),
  constraint rv2_sync_jobs_failure_check check (failure_count between 0 and 8),
  constraint rv2_sync_jobs_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint rv2_sync_jobs_cursor_check check (
    jsonb_typeof(page_cursor) = 'object' and octet_length(page_cursor::text) <= 4096
  ),
  constraint rv2_sync_jobs_page_number_check check (page_number >= 0),
  constraint rv2_sync_jobs_page_digest_check check (
    previous_page_digest is null or previous_page_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_sync_jobs_claim_state_check check (
    (status = 'CLAIMED' and worker_subject is not null and claim_token is not null and lease_expires_at is not null)
    or (status <> 'CLAIMED')
  ),
  constraint rv2_sync_jobs_commit_state_check check (
    (not page_committed and page_number = 0 and not sync_complete)
    or (page_committed and page_number > 0)
  ),
  constraint rv2_sync_jobs_complete_state_check check (
    (status = 'SUCCEEDED' and sync_complete and completed_at is not null)
    or (status <> 'SUCCEEDED' and not sync_complete)
  )
);

create table private.rv2_sync_attempts (
  tenant_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null default gen_random_uuid(),
  attempt_no integer not null,
  worker_subject uuid not null,
  claim_token uuid not null,
  status text not null default 'CLAIMED',
  error_code text,
  claimed_at timestamptz not null default statement_timestamp(),
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  constraint rv2_sync_attempts_pkey primary key (attempt_id),
  constraint rv2_sync_attempts_job_attempt_key unique (tenant_id, job_id, attempt_no),
  constraint rv2_sync_attempts_claim_key unique (claim_token),
  constraint rv2_sync_attempts_job_fkey foreign key (tenant_id, job_id)
    references private.rv2_sync_jobs (tenant_id, job_id) on delete cascade,
  constraint rv2_sync_attempts_status_check check (
    status in ('CLAIMED', 'COMMITTED', 'FAILED', 'EXPIRED')
  ),
  constraint rv2_sync_attempts_error_check check (
    error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create table private.rv2_sync_partitions (
  tenant_id uuid not null,
  connection_id uuid not null,
  dataset text not null,
  partition_key text not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_sync_partitions_pkey
    primary key (tenant_id, connection_id, dataset, partition_key),
  constraint rv2_sync_partitions_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_sync_partitions_dataset_check check (
    dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
  ),
  constraint rv2_sync_partitions_key_check check (
    length(partition_key) between 1 and 128 and partition_key ~ '^[A-Za-z0-9._:/-]+$'
  ),
  constraint rv2_sync_partitions_status_check check (status in ('ACTIVE', 'COMPLETE', 'DISABLED'))
);

create table private.rv2_sync_coverage (
  tenant_id uuid not null,
  connection_id uuid not null,
  dataset text not null,
  partition_key text not null,
  state text not null default 'UNKNOWN',
  attempted_through timestamptz,
  fetched_through timestamptz,
  committed_through timestamptz,
  trusted_through timestamptz,
  updated_by_job_id uuid,
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_sync_coverage_pkey
    primary key (tenant_id, connection_id, dataset, partition_key),
  constraint rv2_sync_coverage_partition_fkey
    foreign key (tenant_id, connection_id, dataset, partition_key)
    references private.rv2_sync_partitions (tenant_id, connection_id, dataset, partition_key)
    on delete cascade,
  constraint rv2_sync_coverage_state_check check (
    state in ('VERIFIED', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT')
  ),
  constraint rv2_sync_coverage_trusted_committed_check check (
    trusted_through is null or (
      attempted_through is not null and fetched_through is not null
      and committed_through is not null and trusted_through <= committed_through
    )
  ),
  constraint rv2_sync_coverage_committed_fetched_check check (
    committed_through is null or (
      fetched_through is not null and attempted_through is not null
      and committed_through <= fetched_through
    )
  ),
  constraint rv2_sync_coverage_fetched_attempted_check check (
    fetched_through is null or (
      attempted_through is not null and fetched_through <= attempted_through
    )
  )
);

create table private.rv2_source_event_conflicts (
  tenant_id uuid not null,
  connection_id uuid not null,
  conflict_id uuid not null default gen_random_uuid(),
  dataset text not null,
  provider_event_id text not null,
  existing_sha256 text not null,
  observed_sha256 text not null,
  first_job_id uuid not null,
  last_job_id uuid not null,
  status text not null default 'OPEN',
  occurrences bigint not null default 1,
  first_seen_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  constraint rv2_source_event_conflicts_pkey primary key (conflict_id),
  constraint rv2_source_event_conflicts_identity_key unique (
    tenant_id, connection_id, dataset, provider_event_id
  ),
  constraint rv2_source_event_conflicts_connection_fkey
    foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_source_event_conflicts_dataset_check check (
    dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
  ),
  constraint rv2_source_event_conflicts_provider_id_check check (
    length(provider_event_id) between 1 and 192
  ),
  constraint rv2_source_event_conflicts_digest_check check (
    existing_sha256 ~ '^[0-9a-f]{64}$'
    and observed_sha256 ~ '^[0-9a-f]{64}$'
    and existing_sha256 <> observed_sha256
  ),
  constraint rv2_source_event_conflicts_status_check check (
    (status = 'OPEN' and resolved_at is null)
    or (status = 'RESOLVED' and resolved_at is not null)
  ),
  constraint rv2_source_event_conflicts_occurrences_check check (occurrences > 0)
);

create table private.rv2_ledger_shadow_submissions (
  tenant_id uuid not null,
  connection_id uuid not null,
  job_id uuid not null,
  page_number bigint not null,
  credential_version bigint not null,
  source_claim_token uuid not null,
  projection jsonb not null,
  projection_sha256 text not null,
  reconciliation jsonb not null,
  status text not null default 'SHADOW_ONLY',
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_ledger_shadow_submissions_pkey primary key (
    tenant_id, job_id, page_number
  ),
  constraint rv2_ledger_shadow_submissions_job_fkey
    foreign key (tenant_id, job_id)
    references private.rv2_sync_jobs (tenant_id, job_id) on delete cascade,
  constraint rv2_ledger_shadow_submissions_connection_fkey
    foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_ledger_shadow_submissions_page_check check (page_number > 0),
  constraint rv2_ledger_shadow_submissions_projection_check check (
    jsonb_typeof(projection) = 'object' and octet_length(projection::text) <= 1048576
  ),
  constraint rv2_ledger_shadow_submissions_digest_check check (
    projection_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_ledger_shadow_submissions_reconciliation_check check (
    jsonb_typeof(reconciliation) = 'object'
    and reconciliation ->> 'stage' = 'SHADOW'
    and reconciliation ->> 'status' = 'NOT_EVALUATED'
    and reconciliation -> 'realGeneration' = 'false'::jsonb
    and reconciliation -> 'generation' = 'null'::jsonb
  ),
  constraint rv2_ledger_shadow_submissions_status_check check (status = 'SHADOW_ONLY')
);

-- Source-page commit and its derived fixed side effects share one transaction.
-- The effect stays private; claims expose only its digest and binding columns.
create table private.rv2_post_commit_work (
  tenant_id uuid not null,
  work_id uuid not null default gen_random_uuid(),
  job_id uuid not null,
  connection_id uuid not null,
  credential_version bigint not null,
  attempt_id uuid not null,
  page_number bigint not null,
  source_worker_subject uuid not null,
  source_claim_token uuid not null,
  work_kind text not null default 'SYNC_EFFECTS',
  effect jsonb not null,
  input_digest text not null,
  status text not null default 'PENDING',
  failure_count integer not null default 0,
  worker_subject uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz not null default statement_timestamp(),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_post_commit_work_pkey primary key (work_id),
  constraint rv2_post_commit_work_page_key unique (tenant_id, job_id, page_number),
  constraint rv2_post_commit_work_job_fkey foreign key (tenant_id, job_id)
    references private.rv2_sync_jobs (tenant_id, job_id) on delete cascade,
  constraint rv2_post_commit_work_attempt_fkey foreign key (attempt_id)
    references private.rv2_sync_attempts (attempt_id) on delete cascade,
  constraint rv2_post_commit_work_connection_fkey
    foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_post_commit_work_page_check check (page_number > 0),
  constraint rv2_post_commit_work_kind_check check (work_kind = 'SYNC_EFFECTS'),
  constraint rv2_post_commit_work_effect_check check (
    jsonb_typeof(effect) = 'object'
    and effect ->> 'protocol' = 'rv-sync-post-commit/1'
    and jsonb_typeof(effect -> 'symbols') = 'array'
    and jsonb_array_length(effect -> 'symbols') <= 256
    and (effect -> 'ledgerShadow' = 'null'::jsonb
      or jsonb_typeof(effect -> 'ledgerShadow') = 'object')
    and octet_length(effect::text) <= 1179648
  ),
  constraint rv2_post_commit_work_digest_check check (input_digest ~ '^[0-9a-f]{64}$'),
  constraint rv2_post_commit_work_status_check check (
    status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')
  ),
  constraint rv2_post_commit_work_failure_check check (failure_count between 0 and 8),
  constraint rv2_post_commit_work_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint rv2_post_commit_work_claim_check check (
    (status = 'CLAIMED' and worker_subject is not null and lease_token is not null
      and lease_expires_at is not null)
    or status <> 'CLAIMED'
  ),
  constraint rv2_post_commit_work_completion_check check (
    (status in ('DONE', 'FAILED') and completed_at is not null)
    or (status in ('PENDING', 'CLAIMED') and completed_at is null)
  )
);

create table private.rv2_sync_gaps (
  tenant_id uuid not null,
  connection_id uuid not null,
  dataset text not null,
  partition_key text not null,
  gap_id uuid not null default gen_random_uuid(),
  gap_code text not null,
  gap_start timestamptz not null,
  gap_end timestamptz not null,
  status text not null default 'OPEN',
  detected_by_job_id uuid not null,
  detected_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  constraint rv2_sync_gaps_pkey primary key (gap_id),
  constraint rv2_sync_gaps_coverage_fkey
    foreign key (tenant_id, connection_id, dataset, partition_key)
    references private.rv2_sync_coverage (tenant_id, connection_id, dataset, partition_key)
    on delete cascade,
  constraint rv2_sync_gaps_code_check check (gap_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint rv2_sync_gaps_range_check check (gap_start < gap_end),
  constraint rv2_sync_gaps_status_check check (status in ('OPEN', 'RESOLVED', 'ACCEPTED_UNKNOWN'))
);

-- The asynchronous Binance archive flow is a separate, resumable control
-- plane.  It reuses the originating sync job id so the internal worker grant
-- remains bound to one pre-existing user-authorized job.
create table private.rv2_archive_jobs (
  tenant_id uuid not null,
  job_id uuid not null,
  connection_id uuid not null,
  credential_version bigint not null,
  dataset text not null,
  window_start text not null,
  window_end text not null,
  archive_state jsonb,
  status text not null default 'QUEUED',
  failure_count integer not null default 0,
  worker_subject uuid,
  claim_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz not null default statement_timestamp(),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_archive_jobs_pkey primary key (job_id),
  constraint rv2_archive_jobs_tenant_job_key unique (tenant_id, job_id),
  constraint rv2_archive_jobs_sync_job_fkey foreign key (tenant_id, job_id)
    references private.rv2_sync_jobs (tenant_id, job_id) on delete cascade,
  constraint rv2_archive_jobs_connection_fkey
    foreign key (tenant_id, connection_id, credential_version)
    references private.rv2_credential_envelopes
      (tenant_id, connection_id, credential_version),
  constraint rv2_archive_jobs_dataset_check check (dataset in ('fills', 'orders', 'income')),
  constraint rv2_archive_jobs_window_check check (
    window_start ~ '^[0-9]{1,128}$'
    and window_end ~ '^[0-9]{1,128}$'
    and window_start::numeric <= window_end::numeric
    and window_end::numeric - window_start::numeric <= 2678400000
  ),
  constraint rv2_archive_jobs_state_check check (
    archive_state is null or (
      jsonb_typeof(archive_state) = 'object'
      and octet_length(archive_state::text) <= 16384
    )
  ),
  constraint rv2_archive_jobs_status_check check (
    status in (
      'QUEUED', 'CLAIMED', 'REQUEST_PENDING', 'POLL_PENDING',
      'CSV_REQUIRED', 'STAGED', 'FAILED', 'CANCELLED'
    )
  ),
  constraint rv2_archive_jobs_failure_check check (failure_count between 0 and 8),
  constraint rv2_archive_jobs_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint rv2_archive_jobs_claim_check check (
    (status = 'CLAIMED' and worker_subject is not null
      and claim_token is not null and lease_expires_at is not null)
    or (status <> 'CLAIMED' and claim_token is null and lease_expires_at is null)
  ),
  constraint rv2_archive_jobs_terminal_check check (
    (status in ('CSV_REQUIRED', 'STAGED', 'FAILED', 'CANCELLED') and completed_at is not null)
    or (status not in ('CSV_REQUIRED', 'STAGED', 'FAILED', 'CANCELLED') and completed_at is null)
  )
);

create table private.rv2_archives (
  tenant_id uuid not null,
  archive_id uuid not null default gen_random_uuid(),
  job_id uuid not null,
  connection_id uuid not null,
  dataset text not null,
  partition_key text not null,
  object_ref_hash text not null,
  archive_sha256 text,
  bytes bigint,
  payload_evidence_source text,
  download_url text,
  expires_at timestamptz,
  claimed_run_id text,
  claimed_run_attempt text,
  claimed_at timestamptz,
  finalize_sha256 text,
  batch_set_sha256 text,
  source_event_count bigint,
  coverage_evidence jsonb,
  finalized_at timestamptz,
  last_error_code text,
  status text not null default 'PENDING',
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_archives_pkey primary key (archive_id),
  constraint rv2_archives_job_fkey foreign key (tenant_id, job_id)
    references private.rv2_archive_jobs (tenant_id, job_id) on delete cascade,
  constraint rv2_archives_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_archives_dataset_check check (
    dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
  ),
  constraint rv2_archives_hash_check check (
    object_ref_hash ~ '^[0-9a-f]{64}$'
    and (archive_sha256 is null or archive_sha256 ~ '^[0-9a-f]{64}$')
    and (finalize_sha256 is null or finalize_sha256 ~ '^[0-9a-f]{64}$')
    and (batch_set_sha256 is null or batch_set_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint rv2_archives_bytes_check check (bytes is null or bytes between 1 and 1073741824),
  constraint rv2_archives_payload_evidence_check check (
    (archive_sha256 is null and bytes is null and payload_evidence_source is null)
    or (archive_sha256 is not null and bytes is not null
      and payload_evidence_source in ('UPSTREAM_ATTESTED', 'WORKFLOW_OBSERVED'))
  ),
  constraint rv2_archives_url_check check (
    download_url is null or (
      length(download_url) between 16 and 4096
      and download_url ~ '^https://[^/?#[:space:]]+(/[^[:space:]]*)?$'
      and download_url !~ '[[:cntrl:]]'
    )
  ),
  constraint rv2_archives_status_check check (
    status in (
      'PENDING', 'READY', 'CLAIMED', 'ATTESTED',
      'COMPLETED', 'CONFLICT', 'FAILED', 'EXPIRED'
    )
  ),
  constraint rv2_archives_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint rv2_archives_ready_check check (
    status <> 'READY' or (
      download_url is not null and expires_at is not null and completed_at is not null
      and archive_sha256 is not null and bytes is not null
    )
  ),
  constraint rv2_archives_claim_check check (
    (claimed_run_id is null and claimed_run_attempt is null and claimed_at is null)
    or (
      claimed_run_id ~ '^[1-9][0-9]{0,19}$'
      and claimed_run_attempt ~ '^[1-9][0-9]{0,9}$'
      and claimed_at is not null
    )
  ),
  constraint rv2_archives_finalize_check check (
    (status not in ('COMPLETED', 'CONFLICT')
      and finalize_sha256 is null and batch_set_sha256 is null
      and source_event_count is null and coverage_evidence is null and finalized_at is null)
    or (status in ('COMPLETED', 'CONFLICT')
      and archive_sha256 is not null and bytes is not null
      and finalize_sha256 is not null and batch_set_sha256 is not null
      and source_event_count is not null and source_event_count >= 0
      and jsonb_typeof(coverage_evidence) = 'object'
      and finalized_at is not null)
  )
);

create table private.rv2_egress_receipts (
  tenant_id uuid not null,
  receipt_id uuid not null default gen_random_uuid(),
  connection_id uuid,
  purpose text not null,
  object_sha256 text not null,
  bytes bigint not null,
  status text not null default 'AUTHORIZED',
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_egress_receipts_pkey primary key (receipt_id),
  constraint rv2_egress_receipts_tenant_fkey foreign key (tenant_id)
    references public.rv2_tenants (tenant_id) on delete cascade,
  constraint rv2_egress_receipts_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_egress_receipts_purpose_check check (
    purpose in ('USER_EXPORT', 'BACKUP_VERIFY', 'ARCHIVE_RESTORE')
  ),
  constraint rv2_egress_receipts_sha_check check (object_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_egress_receipts_bytes_check check (bytes between 0 and 1073741824),
  constraint rv2_egress_receipts_status_check check (
    status in ('AUTHORIZED', 'COMPLETED', 'FAILED', 'EXPIRED')
  )
);

-- One GitHub run/attempt may receive one archive URL at most.  This is a
-- database boundary in addition to the workflow concurrency group: retries
-- never receive the URL again and concurrent requests cannot consume a second
-- PENDING archive under the same OIDC grant.
create unique index rv2_archives_claimed_run_attempt_key
  on private.rv2_archives (claimed_run_id, claimed_run_attempt)
  where claimed_run_id is not null and claimed_run_attempt is not null;

create table private.rv2_backup_runs (
  tenant_id uuid not null,
  backup_id uuid not null default gen_random_uuid(),
  connection_id uuid,
  generation bigint,
  manifest_sha256 text,
  object_count integer not null default 0,
  bytes bigint not null default 0,
  status text not null default 'PENDING',
  error_code text,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint rv2_backup_runs_pkey primary key (backup_id),
  constraint rv2_backup_runs_tenant_fkey foreign key (tenant_id)
    references public.rv2_tenants (tenant_id) on delete cascade,
  constraint rv2_backup_runs_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_backup_runs_sha_check check (
    manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_backup_runs_count_check check (object_count between 0 and 1000000),
  constraint rv2_backup_runs_bytes_check check (bytes between 0 and 1099511627776),
  constraint rv2_backup_runs_status_check check (
    status in ('PENDING', 'RUNNING', 'VERIFIED', 'FAILED', 'EXPIRED')
  ),
  constraint rv2_backup_runs_error_check check (
    error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create table private.rv2_review_requests (
  tenant_id uuid not null,
  connection_id uuid not null,
  idempotency_key uuid not null,
  trade_id text not null,
  request_fingerprint text not null,
  review_id uuid not null,
  resulting_version bigint not null,
  resulting_updated_at timestamptz not null,
  result_snapshot jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_review_requests_pkey primary key (
    tenant_id, connection_id, idempotency_key
  ),
  constraint rv2_review_requests_connection_fkey foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_review_requests_review_fkey
    foreign key (tenant_id, connection_id, review_id, trade_id)
    references public.rv2_reviews
      (tenant_id, connection_id, review_id, trade_id) on delete cascade,
  constraint rv2_review_requests_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_review_requests_trade_check check (trade_id ~ '^t_[0-9a-f]{16}$'),
  constraint rv2_review_requests_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_review_requests_version_check check (resulting_version > 0)
  ,constraint rv2_review_requests_snapshot_check check (
    jsonb_typeof(result_snapshot) = 'object'
    and octet_length(result_snapshot::text) <= 4096
  )
);

create table private.rv2_domain_mutation_requests (
  tenant_id uuid not null,
  connection_id uuid not null,
  resource_kind text not null,
  idempotency_key uuid not null,
  resource_id text not null,
  request_fingerprint text not null,
  resulting_version bigint not null,
  resulting_updated_at timestamptz not null,
  result_snapshot jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint rv2_domain_mutation_requests_pkey primary key (
    tenant_id, connection_id, resource_kind, idempotency_key
  ),
  constraint rv2_domain_mutation_requests_connection_fkey
    foreign key (tenant_id, connection_id)
    references public.rv2_connections (tenant_id, connection_id) on delete cascade,
  constraint rv2_domain_mutation_requests_member_fkey foreign key (tenant_id, created_by)
    references public.rv2_memberships (tenant_id, user_id),
  constraint rv2_domain_mutation_requests_kind_check check (
    resource_kind in ('ACTION', 'JOURNAL', 'RISK', 'REPORT')
  ),
  constraint rv2_domain_mutation_requests_resource_check check (
    length(resource_id) between 1 and 128 and resource_id !~ '[[:cntrl:]]'
  ),
  constraint rv2_domain_mutation_requests_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint rv2_domain_mutation_requests_version_check check (resulting_version > 0),
  constraint rv2_domain_mutation_requests_snapshot_check check (
    jsonb_typeof(result_snapshot) = 'object'
    and octet_length(result_snapshot::text) <= 4096
  )
);

create table private.rv2_trade_projection_evidence (
  tenant_id uuid not null,
  connection_id uuid not null,
  generation bigint not null,
  projector_protocol text not null default 'rv2-trade-projector/1',
  source_event_count bigint not null,
  model_count bigint not null,
  projection_sha256 text not null,
  projected_at timestamptz not null default statement_timestamp(),
  constraint rv2_trade_projection_evidence_pkey
    primary key (tenant_id, connection_id, generation),
  constraint rv2_trade_projection_evidence_generation_fkey
    foreign key (tenant_id, connection_id, generation)
    references public.rv2_generations (tenant_id, connection_id, generation) on delete cascade,
  constraint rv2_trade_projection_evidence_protocol_check
    check (projector_protocol = 'rv2-trade-projector/1'),
  constraint rv2_trade_projection_evidence_count_check
    check (source_event_count between 0 and 1000000 and model_count between 0 and 500000),
  constraint rv2_trade_projection_evidence_sha_check
    check (projection_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.rv2_ops_oidc_claims (
  claim_id uuid not null default gen_random_uuid(),
  oidc_jti_sha256 text not null,
  capability text not null,
  expires_at timestamptz not null,
  binding jsonb not null,
  binding_sha256 text not null,
  repository text not null,
  git_ref text not null,
  workflow_ref text not null,
  run_id text not null,
  run_attempt text not null,
  job_name text not null,
  claimed_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_oidc_claims_pkey primary key (claim_id),
  constraint rv2_ops_oidc_claims_jti_key unique (oidc_jti_sha256),
  constraint rv2_ops_oidc_claims_run_capability_key unique (
    capability, run_id, run_attempt
  ),
  constraint rv2_ops_oidc_claims_capability_check check (
    capability in ('beta-backup', 'beta-archive', 'beta-capacity-observe')
  ),
  constraint rv2_ops_oidc_claims_sha_check check (
    oidc_jti_sha256 ~ '^[0-9a-f]{64}$' and binding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint rv2_ops_oidc_claims_binding_check check (
    jsonb_typeof(binding) = 'object' and octet_length(binding::text) <= 8192
  ),
  constraint rv2_ops_oidc_claims_run_check check (
    run_id ~ '^[1-9][0-9]{0,19}$' and run_attempt ~ '^[1-9][0-9]{0,9}$'
  ),
  constraint rv2_ops_oidc_claims_expiry_check check (expires_at > claimed_at)
);

create table private.rv2_ops_backup_snapshots (
  snapshot_id text not null,
  run_id text not null,
  run_attempt text not null,
  snapshot_epoch timestamptz not null,
  generation bigint not null,
  status text not null default 'MATERIALIZING',
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '24 hours',
  signed_at timestamptz,
  constraint rv2_ops_backup_snapshots_pkey primary key (snapshot_id),
  constraint rv2_ops_backup_snapshots_run_key unique (run_id, run_attempt),
  constraint rv2_ops_backup_snapshots_id_check check (snapshot_id ~ '^[a-f0-9]{32}$'),
  constraint rv2_ops_backup_snapshots_run_check check (
    run_id ~ '^[1-9][0-9]{0,19}$' and run_attempt ~ '^[1-9][0-9]{0,9}$'
  ),
  constraint rv2_ops_backup_snapshots_generation_check check (generation >= 0),
  constraint rv2_ops_backup_snapshots_status_check check (
    status in ('MATERIALIZING', 'READY', 'SIGNED', 'EXPIRED')
  ),
  constraint rv2_ops_backup_snapshots_expiry_check check (expires_at > snapshot_epoch),
  constraint rv2_ops_backup_snapshots_signed_check check (
    (status <> 'SIGNED' and signed_at is null)
    or (status = 'SIGNED' and signed_at is not null)
  )
);

create table private.rv2_ops_backup_snapshot_rows (
  snapshot_id text not null,
  dataset text not null,
  row_ordinal bigint not null,
  row_data jsonb not null,
  row_sha256 text not null,
  constraint rv2_ops_backup_snapshot_rows_pkey primary key (
    snapshot_id, dataset, row_ordinal
  ),
  constraint rv2_ops_backup_snapshot_rows_snapshot_fkey foreign key (snapshot_id)
    references private.rv2_ops_backup_snapshots (snapshot_id) on delete cascade,
  constraint rv2_ops_backup_snapshot_rows_dataset_check check (
    dataset in (
      'trades', 'income', 'orders', 'algo_orders', 'force_orders', 'balances',
      'positions', 'reviews', 'actions', 'journal_entries', 'risk_rules',
      'reports', 'source_events', 'generations', 'connections', 'memberships', 'tenants',
      'ledger_generations', 'reconciliation_generations', 'deletion_tombstones'
    )
  ),
  constraint rv2_ops_backup_snapshot_rows_ordinal_check check (row_ordinal > 0),
  constraint rv2_ops_backup_snapshot_rows_data_check check (
    jsonb_typeof(row_data) = 'object' and octet_length(row_data::text) <= 1048576
  ),
  constraint rv2_ops_backup_snapshot_rows_sha_check check (row_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.rv2_ops_backup_page_evidence (
  snapshot_id text not null,
  run_id text not null,
  run_attempt text not null,
  oidc_jti_sha256 text not null,
  request_cursor text,
  request_cursor_key text not null,
  next_cursor text,
  dataset text not null,
  generation bigint not null,
  row_count integer not null,
  page_sha256 text not null,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_backup_page_evidence_pkey primary key (
    snapshot_id, request_cursor_key
  ),
  constraint rv2_ops_backup_page_evidence_snapshot_fkey foreign key (snapshot_id)
    references private.rv2_ops_backup_snapshots (snapshot_id) on delete cascade,
  constraint rv2_ops_backup_page_evidence_oidc_fkey foreign key (oidc_jti_sha256)
    references private.rv2_ops_oidc_claims (oidc_jti_sha256),
  constraint rv2_ops_backup_page_evidence_cursor_check check (
    length(request_cursor_key) between 1 and 512
    and (request_cursor is null or length(request_cursor) between 1 and 512)
    and (next_cursor is null or length(next_cursor) between 1 and 512)
  ),
  constraint rv2_ops_backup_page_evidence_row_check check (row_count between 0 and 1000),
  constraint rv2_ops_backup_page_evidence_sha_check check (page_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.rv2_ops_backup_signing_claims (
  claim_id uuid not null default gen_random_uuid(),
  run_id text not null,
  run_attempt text not null,
  oidc_jti_sha256 text not null,
  snapshot_id text not null,
  generation bigint not null,
  row_counts jsonb not null,
  scope_prefix text not null,
  object_key text not null,
  object_bytes bigint not null,
  object_sha256 text not null,
  claimed_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_backup_signing_claims_pkey primary key (claim_id),
  constraint rv2_ops_backup_signing_claims_run_key unique (run_id, run_attempt),
  constraint rv2_ops_backup_signing_claims_snapshot_fkey foreign key (snapshot_id)
    references private.rv2_ops_backup_snapshots (snapshot_id),
  constraint rv2_ops_backup_signing_claims_oidc_fkey foreign key (oidc_jti_sha256)
    references private.rv2_ops_oidc_claims (oidc_jti_sha256),
  constraint rv2_ops_backup_signing_claims_rows_check check (
    jsonb_typeof(row_counts) = 'object' and octet_length(row_counts::text) <= 8192
  ),
  constraint rv2_ops_backup_signing_claims_scope_check check (
    length(scope_prefix) between 8 and 512 and object_key like scope_prefix || '%'
  ),
  constraint rv2_ops_backup_signing_claims_object_check check (
    object_bytes between 1 and 1099511627776
    and object_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table private.rv2_ops_restore_runs (
  restore_id text not null,
  active_generation bigint not null,
  target_generation bigint not null,
  status text not null default 'TOMBSTONES_APPLIED',
  tombstone_cutoff timestamptz not null,
  tombstones_applied integer not null default 0,
  tombstones_applied_at timestamptz not null,
  manifest_nonce text,
  manifest_sha256 text,
  source_repository text,
  source_workflow_ref text,
  source_run_id text,
  source_run_attempt text,
  manifest_claimed_at timestamptz,
  lease_subject text,
  ownership_verified boolean not null default false,
  external_tombstone_verified boolean not null default false,
  blocked_reason text not null default 'EXTERNAL_TOMBSTONE_JOURNAL_NOT_VERIFIED',
  expected_batches integer not null default 0,
  received_batches integer not null default 0,
  requires_reconnect boolean not null default true,
  published_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_restore_runs_pkey primary key (restore_id),
  constraint rv2_ops_restore_runs_nonce_key unique (manifest_nonce),
  constraint rv2_ops_restore_runs_manifest_key unique (manifest_sha256),
  constraint rv2_ops_restore_runs_id_check check (restore_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint rv2_ops_restore_runs_generation_check check (
    active_generation >= 0 and target_generation = active_generation + 1
  ),
  constraint rv2_ops_restore_runs_status_check check (
    status in ('TOMBSTONES_APPLIED', 'CLAIMED', 'QUARANTINED', 'FAILED')
  ),
  constraint rv2_ops_restore_runs_manifest_check check (
    (manifest_nonce is null and manifest_sha256 is null and manifest_claimed_at is null)
    or (
      manifest_nonce ~ '^[0-9a-f]{48,128}$'
      and manifest_sha256 ~ '^[0-9a-f]{64}$'
      and manifest_claimed_at is not null
    )
  ),
  constraint rv2_ops_restore_runs_lease_check check (
    lease_subject is null or lease_subject ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  constraint rv2_ops_restore_runs_blocker_check check (
    blocked_reason in (
      'EXTERNAL_TOMBSTONE_JOURNAL_NOT_VERIFIED',
      'OWNERSHIP_LINEAGE_NOT_VERIFIED',
      'AUTH_MAPPING_NOT_VERIFIED'
    )
  ),
  constraint rv2_ops_restore_runs_batch_check check (
    received_batches >= 0 and expected_batches >= received_batches
  ),
  constraint rv2_ops_restore_runs_unpublished_check check (
    published_at is null
    and not ownership_verified
    and not external_tombstone_verified
  )
);

create table private.rv2_ops_restore_batches (
  restore_id text not null,
  target_generation bigint not null,
  dataset text not null,
  batch_index integer not null,
  total_batches integer not null,
  batch_sha256 text not null,
  record_count integer not null,
  received_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_restore_batches_pkey primary key (restore_id, dataset, batch_index),
  constraint rv2_ops_restore_batches_run_fkey foreign key (restore_id)
    references private.rv2_ops_restore_runs (restore_id) on delete cascade,
  constraint rv2_ops_restore_batches_index_check check (
    batch_index >= 0 and total_batches between 1 and 100000 and batch_index < total_batches
  ),
  constraint rv2_ops_restore_batches_dataset_check check (
    dataset in (
      'trades', 'income', 'orders', 'algo_orders', 'force_orders', 'balances',
      'positions', 'reviews', 'actions', 'journal_entries', 'risk_rules',
      'reports', 'source_events', 'generations', 'connections', 'memberships',
      'tenants', 'ledger_generations', 'reconciliation_generations',
      'deletion_tombstones'
    )
  ),
  constraint rv2_ops_restore_batches_sha_check check (batch_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_ops_restore_batches_count_check check (record_count between 1 and 250)
);

create table private.rv2_ops_restore_staging_rows (
  restore_id text not null,
  target_generation bigint not null,
  dataset text not null,
  batch_index integer not null,
  row_ordinal integer not null,
  row_data jsonb not null,
  row_sha256 text not null,
  constraint rv2_ops_restore_staging_rows_pkey primary key (
    restore_id, dataset, batch_index, row_ordinal
  ),
  constraint rv2_ops_restore_staging_rows_batch_fkey
    foreign key (restore_id, dataset, batch_index)
    references private.rv2_ops_restore_batches (restore_id, dataset, batch_index) on delete cascade,
  constraint rv2_ops_restore_staging_rows_ordinal_check check (row_ordinal between 1 and 250),
  constraint rv2_ops_restore_staging_rows_data_check check (
    jsonb_typeof(row_data) = 'object' and octet_length(row_data::text) <= 1048576
  ),
  constraint rv2_ops_restore_staging_rows_sha_check check (row_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.rv2_ops_archive_batches (
  archive_id uuid not null,
  run_id text not null,
  run_attempt text not null,
  dataset text not null,
  batch_index integer not null,
  total_batches integer not null,
  source_file text not null,
  batch_sha256 text not null,
  record_count integer not null,
  received_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_archive_batches_pkey primary key (archive_id, dataset, batch_index),
  constraint rv2_ops_archive_batches_archive_fkey foreign key (archive_id)
    references private.rv2_archives (archive_id) on delete cascade,
  constraint rv2_ops_archive_batches_index_check check (
    batch_index >= 0 and total_batches between 1 and 100000 and batch_index < total_batches
  ),
  constraint rv2_ops_archive_batches_source_check check (source_file = dataset || '.csv'),
  constraint rv2_ops_archive_batches_sha_check check (batch_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rv2_ops_archive_batches_count_check check (record_count between 0 and 250)
);

create table private.rv2_ops_archive_staging_rows (
  archive_id uuid not null,
  dataset text not null,
  provider_event_id text not null,
  event_time timestamptz not null,
  event_body jsonb not null,
  event_sha256 text not null,
  batch_index integer not null,
  row_ordinal integer not null,
  constraint rv2_ops_archive_staging_rows_pkey primary key (
    archive_id, dataset, batch_index, row_ordinal
  ),
  constraint rv2_ops_archive_staging_rows_batch_fkey
    foreign key (archive_id, dataset, batch_index)
    references private.rv2_ops_archive_batches (archive_id, dataset, batch_index) on delete cascade,
  constraint rv2_ops_archive_staging_rows_data_check check (
    jsonb_typeof(event_body) = 'object' and octet_length(event_body::text) <= 65536
  ),
  constraint rv2_ops_archive_staging_rows_provider_check check (
    length(provider_event_id) between 1 and 192 and provider_event_id !~ '[[:cntrl:]]'
  ),
  constraint rv2_ops_archive_staging_rows_ordinal_check check (row_ordinal between 1 and 250),
  constraint rv2_ops_archive_staging_rows_sha_check check (event_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.rv2_deletion_tombstones (
  tenant_id uuid not null,
  receipt_id uuid not null,
  subject_id uuid not null,
  operation text not null,
  deleted_at timestamptz not null,
  backup_purge_after timestamptz not null,
  constraint rv2_deletion_tombstones_pkey primary key (receipt_id),
  constraint rv2_deletion_tombstones_operation_check
    check (operation in ('CLEAR_BUSINESS_DATA', 'DELETE_ACCOUNT')),
  constraint rv2_deletion_tombstones_purge_check
    check (backup_purge_after >= deleted_at + interval '30 days')
);

create table private.rv2_worker_control (
  singleton boolean not null default true,
  circuit_open_until timestamptz,
  last_error_code text,
  updated_at timestamptz not null default statement_timestamp(),
  constraint rv2_worker_control_pkey primary key (singleton),
  constraint rv2_worker_control_singleton_check check (singleton),
  constraint rv2_worker_control_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

insert into private.rv2_worker_control (singleton) values (true);

create index rv2_source_events_generation_read_idx
  on public.rv2_source_events (tenant_id, connection_id, sync_job_id, dataset, event_time, event_id);
create index rv2_reviews_generation_read_idx
  on public.rv2_reviews (tenant_id, connection_id, updated_at, review_id);
create index rv2_sync_jobs_claim_idx
  on private.rv2_sync_jobs (status, queue_class, available_at, job_id);
create index rv2_sync_gaps_open_idx
  on private.rv2_sync_gaps (tenant_id, connection_id, dataset, partition_key, status, gap_start);

create function private.rv2_ops_materialize_backup_snapshot(
  p_snapshot_id text,
  p_snapshot_epoch timestamptz,
  p_generation bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  perform 1
    from private.rv2_ops_backup_snapshots as s
   where s.snapshot_id = p_snapshot_id
     and s.snapshot_epoch = p_snapshot_epoch
     and s.generation = p_generation
     and s.status = 'MATERIALIZING'
   for update;
  if not found then
    raise exception 'backup snapshot unavailable' using errcode = 'P0002';
  end if;

  -- READ COMMITTED gives each statement a fresh snapshot.  Acquire all source
  -- relation locks in one fixed order before the first read so this small
  -- (<=10 account) Beta materialization cannot mix application generations.
  lock table public.rv2_tenants, public.rv2_memberships, public.rv2_connections,
    public.rv2_source_events, public.rv2_generations, public.rv2_reviews,
    public.rv2_actions, public.rv2_journal_entries, public.rv2_risk_rules,
    public.rv2_reports, public.rv2_ledger_generations,
    public.rv2_reconciliation_generations, private.rv2_deletion_tombstones
    in share mode;

  -- Derived execution datasets are copied into an immutable snapshot table.
  -- The explicit object constructors are also the exclusion boundary: no
  -- credential envelope, secret, key reference or temporary URL can enter it.
  insert into private.rv2_ops_backup_snapshot_rows (
    snapshot_id, dataset, row_ordinal, row_data, row_sha256
  )
  select p_snapshot_id,
         case when e.dataset = 'fills' then 'trades' else e.dataset end,
         row_number() over (
           partition by e.dataset order by e.tenant_id, e.connection_id, e.event_time, e.event_id
         ),
         mapped.row_data,
         encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_source_events as e
    join public.rv2_connections as c
      on c.tenant_id = e.tenant_id and c.connection_id = e.connection_id
    cross join lateral (
      select jsonb_strip_nulls(case e.dataset
        when 'fills' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'tradeId', coalesce(e.event_body -> 'tradeId', e.event_body -> 'id'),
          'orderId', e.event_body -> 'orderId', 'symbol', e.event_body -> 'symbol',
          'side', e.event_body -> 'side', 'positionSide', e.event_body -> 'positionSide',
          'time', to_jsonb(e.event_time), 'price', e.event_body -> 'price',
          'qty', e.event_body -> 'qty', 'commission', e.event_body -> 'commission',
          'commissionAsset', e.event_body -> 'commissionAsset',
          'realizedPnl', e.event_body -> 'realizedPnl', 'buyer', e.event_body -> 'buyer',
          'maker', e.event_body -> 'maker', 'generation', c.current_generation
        )
        when 'income' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'transactionId', coalesce(e.event_body -> 'transactionId', e.event_body -> 'tranId'),
          'symbol', e.event_body -> 'symbol', 'incomeType', e.event_body -> 'incomeType',
          'income', e.event_body -> 'income', 'asset', e.event_body -> 'asset',
          'time', to_jsonb(e.event_time), 'info', e.event_body -> 'info',
          'tradeId', e.event_body -> 'tradeId', 'generation', c.current_generation
        )
        when 'orders' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'orderId', e.event_body -> 'orderId', 'clientOrderId', e.event_body -> 'clientOrderId',
          'symbol', e.event_body -> 'symbol', 'side', e.event_body -> 'side',
          'positionSide', e.event_body -> 'positionSide', 'type', e.event_body -> 'type',
          'status', e.event_body -> 'status', 'time', to_jsonb(e.event_time),
          'updateTime', e.event_body -> 'updateTime', 'price', e.event_body -> 'price',
          'avgPrice', e.event_body -> 'avgPrice', 'origQty', e.event_body -> 'origQty',
          'executedQty', e.event_body -> 'executedQty', 'reduceOnly', e.event_body -> 'reduceOnly',
          'closePosition', e.event_body -> 'closePosition', 'generation', c.current_generation
        )
        when 'algo_orders' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'algoId', e.event_body -> 'algoId', 'clientAlgoId', e.event_body -> 'clientAlgoId',
          'symbol', e.event_body -> 'symbol', 'side', e.event_body -> 'side',
          'positionSide', e.event_body -> 'positionSide', 'orderType', e.event_body -> 'orderType',
          'algoStatus', e.event_body -> 'algoStatus', 'createTime', e.event_body -> 'createTime',
          'updateTime', e.event_body -> 'updateTime', 'triggerPrice', e.event_body -> 'triggerPrice',
          'price', e.event_body -> 'price', 'quantity', e.event_body -> 'quantity',
          'generation', c.current_generation
        )
        when 'force_orders' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'orderId', e.event_body -> 'orderId', 'symbol', e.event_body -> 'symbol',
          'side', e.event_body -> 'side', 'positionSide', e.event_body -> 'positionSide',
          'status', e.event_body -> 'status', 'time', to_jsonb(e.event_time),
          'updateTime', e.event_body -> 'updateTime', 'price', e.event_body -> 'price',
          'avgPrice', e.event_body -> 'avgPrice', 'origQty', e.event_body -> 'origQty',
          'executedQty', e.event_body -> 'executedQty',
          'autoCloseType', e.event_body -> 'autoCloseType', 'generation', c.current_generation
        )
        when 'balances' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'asset', e.event_body -> 'asset', 'balance', e.event_body -> 'balance',
          'crossWalletBalance', e.event_body -> 'crossWalletBalance',
          'crossUnPnl', e.event_body -> 'crossUnPnl',
          'availableBalance', e.event_body -> 'availableBalance',
          'maxWithdrawAmount', e.event_body -> 'maxWithdrawAmount',
          'marginAvailable', e.event_body -> 'marginAvailable',
          'updateTime', coalesce(e.event_body -> 'updateTime', to_jsonb(e.event_time)),
          'generation', c.current_generation
        )
        when 'positions' then jsonb_build_object(
          'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
          'symbol', e.event_body -> 'symbol', 'positionSide', e.event_body -> 'positionSide',
          'positionAmt', e.event_body -> 'positionAmt', 'entryPrice', e.event_body -> 'entryPrice',
          'breakEvenPrice', e.event_body -> 'breakEvenPrice', 'markPrice', e.event_body -> 'markPrice',
          'unRealizedProfit', e.event_body -> 'unRealizedProfit',
          'liquidationPrice', e.event_body -> 'liquidationPrice',
          'leverage', e.event_body -> 'leverage', 'marginType', e.event_body -> 'marginType',
          'isolatedMargin', e.event_body -> 'isolatedMargin', 'notional', e.event_body -> 'notional',
          'updateTime', coalesce(e.event_body -> 'updateTime', to_jsonb(e.event_time)),
          'generation', c.current_generation
        )
      end) as row_data
    ) as mapped
   where e.source_observed_at <= p_snapshot_epoch;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'source_events', row_number() over (order by e.tenant_id, e.connection_id, e.event_time, e.event_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_source_events as e
    cross join lateral (select jsonb_build_object(
      'id', e.event_id, 'tenantId', e.tenant_id, 'connectionId', e.connection_id,
      'eventId', e.event_id, 'syncJobId', e.sync_job_id, 'dataset', e.dataset,
      'providerEventId', e.provider_event_id, 'eventTime', e.event_time,
      'eventBody', e.event_body, 'eventSha256', e.event_sha256,
      'sourceObservedAt', e.source_observed_at
    ) as row_data) as mapped
   where e.source_observed_at <= p_snapshot_epoch;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'reviews', row_number() over (order by r.tenant_id, r.connection_id, r.review_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_reviews as r
    cross join lateral (select jsonb_build_object(
      'id', r.review_id, 'tenantId', r.tenant_id, 'connectionId', r.connection_id,
      'reviewId', r.review_id, 'tradeId', r.trade_id, 'version', r.version,
      'payload', r.payload, 'payloadSha256', r.payload_sha256, 'createdBy', r.created_by,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'actions', row_number() over (order by a.tenant_id, a.connection_id, a.action_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_actions as a
    cross join lateral (select jsonb_strip_nulls(jsonb_build_object(
      'id', a.action_id, 'tenantId', a.tenant_id, 'connectionId', a.connection_id,
      'actionId', a.action_id, 'reviewId', a.review_id, 'status', a.status,
      'version', a.version, 'payload', a.payload, 'createdBy', a.created_by,
      'createdAt', a.created_at, 'updatedAt', a.updated_at
    )) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'journal_entries', row_number() over (order by j.tenant_id, j.connection_id, j.journal_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_journal_entries as j
    cross join lateral (select jsonb_build_object(
      'id', j.journal_id, 'tenantId', j.tenant_id, 'connectionId', j.connection_id,
      'journalId', j.journal_id, 'journalDay', j.journal_day, 'version', j.version,
      'payload', j.payload, 'createdBy', j.created_by,
      'createdAt', j.created_at, 'updatedAt', j.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'risk_rules', row_number() over (order by r.tenant_id, r.connection_id, r.rule_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_risk_rules as r
    cross join lateral (select jsonb_build_object(
      'id', r.rule_id, 'tenantId', r.tenant_id, 'connectionId', r.connection_id,
      'ruleId', r.rule_id, 'status', r.status, 'version', r.version,
      'payload', r.payload, 'createdBy', r.created_by,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'reports', row_number() over (
           order by r.tenant_id, r.connection_id, r.report_id
         ), mapped.row_data,
         encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_reports as r
    cross join lateral (select jsonb_build_object(
      'id', r.report_id, 'tenantId', r.tenant_id, 'connectionId', r.connection_id,
      'reportId', r.report_id, 'reportType', r.report_type,
      'periodStart', r.period_start, 'periodEnd', r.period_end,
      'sourceGeneration', r.source_generation, 'version', r.version,
      'payload', r.payload, 'payloadSha256', r.payload_sha256,
      'createdBy', r.created_by, 'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'generations', row_number() over (order by g.tenant_id, g.connection_id, g.generation),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_generations as g
    cross join lateral (select jsonb_build_object(
      'id', g.generation_id, 'tenantId', g.tenant_id, 'connectionId', g.connection_id,
      'generation', g.generation, 'generationId', g.generation_id,
      'sourceJobIds', g.source_job_ids, 'coverage', g.coverage,
      'reconciliation', g.reconciliation, 'capabilities', g.capabilities,
      'sourceRootSha256', g.source_root_sha256,
      'sourceEventCount', g.source_event_count,
      'projectionSha256', g.projection_sha256,
      'tradeModelCount', g.trade_model_count,
      'manifestSha256', g.manifest_sha256, 'status', g.status, 'publishedAt', g.published_at
    ) as row_data) as mapped
   where g.published_at <= p_snapshot_epoch;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'connections', row_number() over (order by c.tenant_id, c.connection_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_connections as c
    cross join lateral (select jsonb_strip_nulls(jsonb_build_object(
      'id', c.connection_id, 'tenantId', c.tenant_id, 'connectionId', c.connection_id,
      'provider', c.provider, 'providerScopeHash', c.provider_scope_hash, 'status', c.status,
      'permissionState', c.permission_state, 'consentVersion', c.consent_version,
      'verifiedAt', c.verified_at, 'lastTrustedAt', c.last_trusted_at,
      'currentGeneration', c.current_generation, 'disconnectReceiptId', c.disconnect_receipt_id,
      'disconnectedAt', c.disconnected_at, 'createdAt', c.created_at, 'updatedAt', c.updated_at
    )) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'memberships', row_number() over (order by m.tenant_id, m.user_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_memberships as m
    cross join lateral (select jsonb_build_object(
      'id', m.user_id, 'tenantId', m.tenant_id, 'userId', m.user_id,
      'memberRole', m.member_role, 'status', m.status,
      'membershipVersion', m.membership_version, 'createdAt', m.created_at, 'updatedAt', m.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'tenants', row_number() over (order by t.tenant_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_tenants as t
    cross join lateral (select jsonb_strip_nulls(jsonb_build_object(
      'id', t.tenant_id, 'tenantId', t.tenant_id, 'status', t.status,
      'deletionReceiptId', t.deletion_receipt_id, 'createdAt', t.created_at, 'deletedAt', t.deleted_at
    )) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'ledger_generations', row_number() over (order by l.tenant_id, l.connection_id, l.generation),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_ledger_generations as l
    cross join lateral (select jsonb_strip_nulls(jsonb_build_object(
      'id', l.connection_id::text || ':' || l.generation::text,
      'tenantId', l.tenant_id, 'connectionId', l.connection_id, 'generation', l.generation,
      'status', l.status, 'projectionSha256', l.projection_sha256, 'reasonCodes', l.reason_codes,
      'createdAt', l.created_at, 'updatedAt', l.updated_at
    )) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'reconciliation_generations', row_number() over (order by r.tenant_id, r.connection_id, r.generation),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from public.rv2_reconciliation_generations as r
    cross join lateral (select jsonb_build_object(
      'id', r.connection_id::text || ':' || r.generation::text,
      'tenantId', r.tenant_id, 'connectionId', r.connection_id, 'generation', r.generation,
      'state', r.state, 'status', r.status, 'reasonCodes', r.reason_codes,
      'checks', r.checks, 'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as row_data) as mapped;

  insert into private.rv2_ops_backup_snapshot_rows
    (snapshot_id, dataset, row_ordinal, row_data, row_sha256)
  select p_snapshot_id, 'deletion_tombstones', row_number() over (order by d.deleted_at, d.receipt_id),
         mapped.row_data, encode(extensions.digest(convert_to(mapped.row_data::text, 'utf8'), 'sha256'), 'hex')
    from private.rv2_deletion_tombstones as d
    cross join lateral (select jsonb_build_object(
      'id', d.receipt_id, 'tenantId', d.tenant_id,
      'receiptId', d.receipt_id, 'deletedAt', d.deleted_at
    ) as row_data) as mapped
   where d.deleted_at <= p_snapshot_epoch;

  update private.rv2_ops_backup_snapshots as s
     set status = 'READY'
   where s.snapshot_id = p_snapshot_id and s.status = 'MATERIALIZING';
  if not found then
    raise exception 'backup snapshot unavailable' using errcode = '40001';
  end if;
end
$function$;

create function private.rv2_enforce_tenant_limits()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_count integer;
begin
  if tg_table_schema <> 'public'
     or tg_table_name not in ('rv2_memberships', 'rv2_connections')
     or new.tenant_id is null then
    raise exception 'tenant capacity unavailable' using errcode = '55000';
  end if;

  if new.status <> 'ACTIVE' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'ACTIVE' then
    return new;
  end if;

  -- The invitation ceiling is global for this Free-plan Beta, not per tenant.
  -- One transaction-scoped lock closes races between separate tenant creates.
  perform pg_advisory_xact_lock(
    hashtextextended('review-workbench-rv2-global-invite-beta-limit', 0)
  );

  if tg_table_name = 'rv2_memberships' then
    select count(*) into v_count
      from public.rv2_memberships as m
     where m.status = 'ACTIVE';
  else
    select count(*) into v_count
      from public.rv2_connections as c
     where c.status = 'ACTIVE';
  end if;
  if v_count >= 10 then
    raise exception 'global invite beta capacity exceeded' using errcode = '54000';
  end if;
  return new;
end
$function$;

create trigger rv2_memberships_tenant_limit
before insert or update of status on public.rv2_memberships
for each row execute function private.rv2_enforce_tenant_limits();

create trigger rv2_connections_tenant_limit
before insert or update of status on public.rv2_connections
for each row execute function private.rv2_enforce_tenant_limits();

create function private.rv2_reject_source_event_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  raise exception 'source events are immutable' using errcode = '55000';
end
$function$;

create trigger rv2_source_events_immutable
before update on public.rv2_source_events
for each row execute function private.rv2_reject_source_event_update();

create function private.rv2_enforce_generation_state_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if tg_table_name = 'rv2_generations' then
    if new.tenant_id is distinct from old.tenant_id
       or new.connection_id is distinct from old.connection_id
       or new.generation is distinct from old.generation
       or new.generation_id is distinct from old.generation_id
       or new.credential_version is distinct from old.credential_version
       or new.source_job_ids is distinct from old.source_job_ids
       or new.coverage is distinct from old.coverage
       or new.reconciliation is distinct from old.reconciliation
       or new.capabilities is distinct from old.capabilities
       or new.manifest_sha256 is distinct from old.manifest_sha256
       or new.published_at is distinct from old.published_at
       or (old.status <> 'PUBLISHED' and new.status <> old.status)
       or (old.status = 'PUBLISHED' and new.status not in ('PUBLISHED', 'SUPERSEDED', 'REVOKED')) then
      raise exception 'generation state transition rejected' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_table_name = 'rv2_ledger_generations' then
    if (old.status = 'SHADOW_PENDING' and new.status not in ('SHADOW_PENDING', 'SHADOW_READY', 'SHADOW_FAILED', 'SUPERSEDED'))
       or (old.status in ('SHADOW_READY', 'SHADOW_FAILED') and new.status not in (old.status, 'SUPERSEDED'))
       or (old.status = 'SUPERSEDED' and new.status <> old.status) then
      raise exception 'ledger shadow state transition rejected' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_table_name = 'rv2_reconciliation_generations' then
    if (old.state = 'PENDING' and new.state not in ('PENDING', 'RUNNING', 'FINAL', 'SUPERSEDED'))
       or (old.state = 'RUNNING' and new.state not in ('RUNNING', 'FINAL', 'SUPERSEDED'))
       or (old.state = 'FINAL' and new.state not in ('FINAL', 'SUPERSEDED'))
       or (old.state = 'SUPERSEDED' and new.state <> old.state) then
      raise exception 'reconciliation state transition rejected' using errcode = '55000';
    end if;
    return new;
  end if;

  raise exception 'generation state transition unavailable' using errcode = '55000';
end
$function$;

create trigger rv2_generations_state_machine
before update on public.rv2_generations
for each row execute function private.rv2_enforce_generation_state_transition();

create trigger rv2_ledger_generations_state_machine
before update on public.rv2_ledger_generations
for each row execute function private.rv2_enforce_generation_state_transition();

create trigger rv2_reconciliation_generations_state_machine
before update on public.rv2_reconciliation_generations
for each row execute function private.rv2_enforce_generation_state_transition();

create function private.rv2_require_browser_tenant()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_subject is null or coalesce(auth.role(), '') <> 'authenticated' then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
  perform public.rv_current_session_is_live();
  select m.tenant_id into v_tenant_id
    from public.rv2_memberships as m
    join public.rv2_tenants as t on t.tenant_id = m.tenant_id
   where m.user_id = v_subject
     and m.member_role = 'OWNER'
     and m.status = 'ACTIVE'
     and t.status = 'ACTIVE';
  if v_tenant_id is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  return v_tenant_id;
end
$function$;

create function private.rv2_require_service_membership(
  p_subject uuid,
  p_tenant_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_role text;
begin
  if p_subject is null or p_tenant_id is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select m.member_role into v_role
    from public.rv2_memberships as m
    join public.rv2_tenants as t on t.tenant_id = m.tenant_id
   where m.tenant_id = p_tenant_id
     and m.user_id = p_subject
     and m.member_role = 'OWNER'
     and m.status = 'ACTIVE'
     and t.status = 'ACTIVE';
  if v_role is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  return v_role;
end
$function$;

create function private.rv2_payload_has_credential_key(
  p_value jsonb,
  p_depth integer default 0
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_key text;
  v_child jsonb;
begin
  if p_depth > 8 then return true; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      if v_key ~* '(api.?secret|api.?key|authorization|credential|password|private.?key|refresh.?token|access.?token)'
         or private.rv2_payload_has_credential_key(v_child, p_depth + 1) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if private.rv2_payload_has_credential_key(v_child, p_depth + 1) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end
$function$;

create function private.rv2_execution_row_is_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_key_count integer;
  v_time numeric;
  v_price numeric;
  v_qty numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object'
     or not (p_value ?& array[
       'id', 'symbol', 'pair', 'side', 'positionSide', 'time', 'price', 'qty',
       'quoteQty', 'baseQty', 'commission', 'commissionAsset',
       'realizedPnl', 'realizedPnlAsset'
     ]) then
    return false;
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_value);
  if v_key_count <> 14
     or jsonb_typeof(p_value -> 'id') <> 'string'
     or jsonb_typeof(p_value -> 'symbol') <> 'string'
     or jsonb_typeof(p_value -> 'pair') <> 'string'
     or jsonb_typeof(p_value -> 'side') <> 'string'
     or jsonb_typeof(p_value -> 'positionSide') <> 'string'
     or jsonb_typeof(p_value -> 'time') <> 'string'
     or jsonb_typeof(p_value -> 'price') <> 'string'
     or jsonb_typeof(p_value -> 'qty') <> 'string'
     or jsonb_typeof(p_value -> 'quoteQty') <> 'string'
     or jsonb_typeof(p_value -> 'baseQty') <> 'string'
     or jsonb_typeof(p_value -> 'commission') <> 'string'
     or jsonb_typeof(p_value -> 'commissionAsset') <> 'string'
     or jsonb_typeof(p_value -> 'realizedPnl') <> 'string'
     or jsonb_typeof(p_value -> 'realizedPnlAsset') <> 'string'
     or (p_value ->> 'id') !~ '^(0|[1-9][0-9]{0,39})$'
     or (p_value ->> 'symbol') !~ '^[A-Z0-9]{2,24}(USDT|USDC)$'
     or (p_value ->> 'pair') <> (p_value ->> 'symbol')
     or (p_value ->> 'side') not in ('BUY', 'SELL')
     or (p_value ->> 'positionSide') not in ('BOTH', 'LONG', 'SHORT')
     or (p_value ->> 'time') !~ '^[0-9]{13}$'
     or (p_value ->> 'price') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
     or (p_value ->> 'qty') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
     or (p_value ->> 'quoteQty') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
     or (p_value ->> 'baseQty') <> '0'
     or (p_value ->> 'commission') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
     or (p_value ->> 'realizedPnl') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
     or (p_value ->> 'commissionAsset') !~ '^[A-Z0-9]{2,16}$'
     or (p_value ->> 'realizedPnlAsset') not in ('USDT', 'USDC')
     or not (
       ((p_value ->> 'symbol') like '%USDT' and (p_value ->> 'realizedPnlAsset') = 'USDT')
       or ((p_value ->> 'symbol') like '%USDC' and (p_value ->> 'realizedPnlAsset') = 'USDC')
     ) then
    return false;
  end if;
  begin
    v_time := (p_value ->> 'time')::numeric;
    v_price := (p_value ->> 'price')::numeric;
    v_qty := (p_value ->> 'qty')::numeric;
  exception when others then
    return false;
  end;
  return v_time between 0 and 9007199254740991
    and trunc(v_time) = v_time
    and v_price > 0
    and v_qty > 0
    and (p_value ->> 'quoteQty')::numeric > 0;
end
$function$;

create function private.rv2_reason_codes_are_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_item jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array'
     or jsonb_array_length(p_value) > 32 then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(v_item) <> 'string'
       or trim(both '"' from v_item::text) !~ '^[A-Z][A-Z0-9_]{0,63}$' then
      return false;
    end if;
  end loop;
  return true;
end
$function$;

create function private.rv2_reconciliation_is_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_key_count integer;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object'
     or not (p_value ?& array['protocol', 'status', 'reasonCodes', 'checks']) then
    return false;
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_value);
  return v_key_count = 4
    and p_value ->> 'protocol' = 'rv-reconciliation/2'
    and p_value ->> 'status' in ('PASS', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT')
    and private.rv2_reason_codes_are_valid(p_value -> 'reasonCodes')
    and jsonb_typeof(p_value -> 'checks') = 'object'
    and octet_length((p_value -> 'checks')::text) <= 65536;
end
$function$;

create function private.rv2_capabilities_are_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_names constant text[] := array[
    'recordsBrowsable', 'observedTradeAnalytics', 'accountKpis', 'currentPositions',
    'equityAnalytics', 'ledger', 'experiments', 'ai'
  ];
  v_name text;
  v_item jsonb;
  v_key_count integer;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object'
     or not (p_value ?& v_names) then
    return false;
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_value);
  if v_key_count <> 8 then
    return false;
  end if;
  foreach v_name in array v_names loop
    v_item := p_value -> v_name;
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['decision', 'reasonCodes']) then
      return false;
    end if;
    select count(*) into v_key_count from jsonb_object_keys(v_item);
    if v_key_count <> 2
       or v_item ->> 'decision' not in ('ALLOW', 'LIMITED', 'DENY')
       or not private.rv2_reason_codes_are_valid(v_item -> 'reasonCodes') then
      return false;
    end if;
  end loop;
  return true;
end
$function$;

create function private.rv2_dataset_coverage_document(
  p_tenant_id uuid,
  p_connection_id uuid,
  p_dataset text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_count integer;
  v_state text;
  v_attempted timestamptz;
  v_fetched timestamptz;
  v_committed timestamptz;
  v_trusted timestamptz;
  v_gaps jsonb;
  v_partitions jsonb;
begin
  -- Coverage is defined by the active partition inventory. A missing coverage
  -- row is therefore UNKNOWN; it must not disappear from the dataset rollup.
  select count(*),
         case when count(c.attempted_through) = count(*)
           then min(c.attempted_through) else null end,
         case when count(c.fetched_through) = count(*)
           then min(c.fetched_through) else null end,
         case when count(c.committed_through) = count(*)
           then min(c.committed_through) else null end,
         case when count(c.trusted_through) = count(*)
           then min(c.trusted_through) else null end
    into v_count, v_attempted, v_fetched, v_committed, v_trusted
    from private.rv2_sync_partitions as p
    left join private.rv2_sync_coverage as c
      on c.tenant_id = p.tenant_id
     and c.connection_id = p.connection_id
     and c.dataset = p.dataset
     and c.partition_key = p.partition_key
   where p.tenant_id = p_tenant_id
     and p.connection_id = p_connection_id
     and p.dataset = p_dataset
     and p.status = 'ACTIVE';

  if v_count = 0 then
    return jsonb_build_object(
      'state', 'UNKNOWN', 'attempted', null, 'fetched', null,
      'committed', null, 'trusted', null, 'gaps', '[]'::jsonb,
      'partitions', '[]'::jsonb
    );
  end if;

  select coalesce(c.state, 'UNKNOWN') into v_state
    from private.rv2_sync_partitions as p
    left join private.rv2_sync_coverage as c
      on c.tenant_id = p.tenant_id
     and c.connection_id = p.connection_id
     and c.dataset = p.dataset
     and c.partition_key = p.partition_key
   where p.tenant_id = p_tenant_id
     and p.connection_id = p_connection_id
     and p.dataset = p_dataset
     and p.status = 'ACTIVE'
   order by case coalesce(c.state, 'UNKNOWN')
     when 'CONFLICT' then 5 when 'UNKNOWN' then 4 when 'STALE' then 3
     when 'PARTIAL' then 2 else 1 end desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'partition', g.partition_key, 'code', g.gap_code,
           'from', g.gap_start, 'to', g.gap_end
         ) order by g.partition_key, g.gap_start, g.gap_id), '[]'::jsonb)
    into v_gaps
    from private.rv2_sync_partitions as p
    join private.rv2_sync_gaps as g
      on g.tenant_id = p.tenant_id
     and g.connection_id = p.connection_id
     and g.dataset = p.dataset
     and g.partition_key = p.partition_key
   where p.tenant_id = p_tenant_id
     and p.connection_id = p_connection_id
     and p.dataset = p_dataset
     and p.status = 'ACTIVE'
     and g.status = 'OPEN';

  select coalesce(jsonb_agg(jsonb_build_object(
           'partition', p.partition_key,
           'state', coalesce(c.state, 'UNKNOWN'),
           'attempted', c.attempted_through,
           'fetched', c.fetched_through,
           'committed', c.committed_through,
           'trusted', c.trusted_through
         ) order by p.partition_key), '[]'::jsonb)
    into v_partitions
    from private.rv2_sync_partitions as p
    left join private.rv2_sync_coverage as c
      on c.tenant_id = p.tenant_id
     and c.connection_id = p.connection_id
     and c.dataset = p.dataset
     and c.partition_key = p.partition_key
   where p.tenant_id = p_tenant_id
     and p.connection_id = p_connection_id
     and p.dataset = p_dataset
     and p.status = 'ACTIVE';

  return jsonb_build_object(
    'state', v_state,
    'attempted', v_attempted,
    'fetched', v_fetched,
    'committed', v_committed,
    'trusted', v_trusted,
    'gaps', v_gaps,
    'partitions', v_partitions
  );
end
$function$;

create function private.rv2_coverage_document(
  p_tenant_id uuid,
  p_connection_id uuid
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'trades', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'fills'),
    'income', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'income'),
    'orders', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'orders'),
    'algoOrders', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'algo_orders'),
    'forceOrders', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'force_orders'),
    'balances', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'balances'),
    'positions', private.rv2_dataset_coverage_document(p_tenant_id, p_connection_id, 'positions')
  );
$function$;

create function private.rv2_default_reconciliation()
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'protocol', 'rv-reconciliation/2',
    'status', 'UNKNOWN',
    'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION'),
    'checks', '{}'::jsonb
  );
$function$;

create function private.rv2_default_capabilities()
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'recordsBrowsable', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'observedTradeAnalytics', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'accountKpis', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'currentPositions', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'equityAnalytics', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'ledger', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('LEDGER_SHADOW_ONLY')),
    'experiments', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION')),
    'ai', jsonb_build_object('decision', 'DENY', 'reasonCodes', jsonb_build_array('NO_PUBLISHED_GENERATION'))
  );
$function$;

create function public.rv2_get_tenant_context()
returns table (
  tenant_id uuid,
  member_role text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  return query
    select m.tenant_id, m.member_role
      from public.rv2_memberships as m
     where m.tenant_id = v_tenant_id
       and m.user_id = auth.uid()
       and m.member_role = 'OWNER'
       and m.status = 'ACTIVE';
end
$function$;

create function private.rv2_require_service_role()
returns void
language plpgsql
stable
set search_path = pg_catalog
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end
$function$;

create function public.rv2_service_provision_tenant(p_subject uuid)
returns table (
  tenant_id uuid,
  member_role text,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_role text;
begin
  if p_subject is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('review-workbench-rv2-provision:' || p_subject::text, 0)
  );

  select m.tenant_id, m.member_role into v_tenant_id, v_role
    from public.rv2_memberships as m
    join public.rv2_tenants as t on t.tenant_id = m.tenant_id
   where m.user_id = p_subject
     and m.member_role = 'OWNER'
     and m.status = 'ACTIVE'
     and t.status = 'ACTIVE';
  if v_tenant_id is not null then
    return query select v_tenant_id, v_role, false;
    return;
  end if;
  if exists (select 1 from public.rv2_memberships as m where m.user_id = p_subject) then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  v_tenant_id := gen_random_uuid();
  insert into public.rv2_tenants (tenant_id) values (v_tenant_id);
  insert into public.rv2_memberships (
    tenant_id, user_id, member_role, status
  ) values (
    v_tenant_id, p_subject, 'OWNER', 'ACTIVE'
  );
  return query select v_tenant_id, 'OWNER'::text, true;
end
$function$;

create function public.rv2_service_create_or_rotate_connection(
  p_subject uuid,
  p_tenant_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_provider_scope_hash text,
  p_permission_state text,
  p_permission_evidence jsonb,
  p_consent_version text,
  p_envelope_ciphertext text,
  p_envelope_nonce text,
  p_envelope_key_ref text,
  p_envelope_sha256 text,
  p_expected_credential_version bigint,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns table (
  connection_id uuid,
  credential_version bigint,
  status text,
  permission_state text,
  permission_evidence jsonb,
  verified_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_operation text;
  v_connection_id uuid;
  v_current_version bigint;
  v_next_version bigint;
  v_status text;
  v_verified_at timestamptz;
  v_prior record;
begin
  perform private.rv2_require_service_membership(p_subject, p_tenant_id);
  perform 1
    from public.rv2_memberships as m
   where m.tenant_id = p_tenant_id
     and m.user_id = p_subject
     and m.status = 'ACTIVE'
     and m.member_role = 'OWNER';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_operation := case when p_expected_credential_version = 0 then 'CREATE' else 'ROTATE' end;

  if p_connection_id is null
     or p_provider <> 'binance'
     or p_provider_scope_hash !~ '^[0-9a-f]{64}$'
     or p_permission_state not in ('READ_ONLY_VERIFIED', 'INSUFFICIENT', 'FAILED')
     or not private.rv2_permission_evidence_is_valid(p_permission_evidence)
     or (p_permission_evidence ->> 'checkedAt')::timestamptz
          < statement_timestamp() - interval '10 minutes'
     or (p_permission_evidence ->> 'checkedAt')::timestamptz
          > statement_timestamp() + interval '1 minute'
     or p_consent_version <> 'rv-binance-beta-consent/1'
     or p_envelope_sha256 !~ '^[0-9a-f]{64}$'
     or p_idempotency_key is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or coalesce(p_expected_credential_version, -1) < 0 then
    raise exception 'connection request rejected' using errcode = '22023';
  end if;

  v_status := case when p_permission_state = 'READ_ONLY_VERIFIED' then 'ACTIVE' else 'DISABLED' end;
  v_verified_at := case when p_permission_state = 'READ_ONLY_VERIFIED'
    then (p_permission_evidence ->> 'checkedAt')::timestamptz else null end;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'review-workbench-rv2-idempotency:' || p_tenant_id::text || ':'
      || v_operation || ':' || p_idempotency_key::text,
      0
    )
  );

  select e.connection_id, e.credential_version, e.request_fingerprint,
         e.permission_state, e.permission_evidence, e.result_status, e.verified_at
    into v_prior
    from private.rv2_credential_envelopes as e
   where e.tenant_id = p_tenant_id
     and e.operation = v_operation
     and e.idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_fingerprint <> p_request_fingerprint then
      raise exception 'idempotency key reused with different request' using errcode = 'P0006';
    end if;
    return query select
      v_prior.connection_id,
      v_prior.credential_version,
      v_prior.result_status,
      v_prior.permission_state,
      v_prior.permission_evidence,
      v_prior.verified_at,
      v_operation = 'CREATE';
    return;
  end if;

  if v_operation = 'CREATE' then
    if p_expected_credential_version <> 0 then
      raise exception 'credential version conflict' using errcode = '40001';
    end if;
    v_connection_id := p_connection_id;
    v_next_version := 1;
    insert into public.rv2_connections (
      tenant_id, connection_id, provider, provider_scope_hash,
      credential_version, status, permission_state, permission_evidence, consent_version,
      verified_at, next_due_at
    ) values (
      p_tenant_id, v_connection_id, p_provider, p_provider_scope_hash,
      v_next_version, v_status, p_permission_state, p_permission_evidence, p_consent_version,
      v_verified_at,
      case when v_status = 'ACTIVE' then statement_timestamp() else null end
    );
  else
    select c.credential_version into v_current_version
      from public.rv2_connections as c
     where c.tenant_id = p_tenant_id
       and c.connection_id = p_connection_id
     for update;
    if not found then
      raise exception 'resource not found' using errcode = 'P0002';
    end if;
    if v_current_version <> p_expected_credential_version then
      raise exception 'credential version conflict' using errcode = '40001';
    end if;
    v_connection_id := p_connection_id;
    v_next_version := v_current_version + 1;
    update private.rv2_credential_envelopes as e
       set retired_at = coalesce(e.retired_at, statement_timestamp())
     where e.tenant_id = p_tenant_id
       and e.connection_id = v_connection_id
       and e.credential_version = v_current_version;
    update private.rv2_sync_attempts as a
       set status = 'FAILED', error_code = 'CREDENTIAL_ROTATED',
           completed_at = statement_timestamp()
     where a.tenant_id = p_tenant_id
       and a.job_id in (
         select j.job_id from private.rv2_sync_jobs as j
          where j.tenant_id = p_tenant_id
            and j.connection_id = v_connection_id
            and j.credential_version = v_current_version
            and j.status in ('QUEUED', 'CLAIMED')
       )
       and a.status = 'CLAIMED';
    update private.rv2_post_commit_work as w
       set status = 'FAILED', worker_subject = null, lease_token = null,
           lease_expires_at = null, last_error_code = 'CREDENTIAL_ROTATED',
           completed_at = statement_timestamp()
     where w.tenant_id = p_tenant_id
       and w.connection_id = v_connection_id
       and w.credential_version = v_current_version
       and w.status in ('PENDING', 'CLAIMED');
    update private.rv2_archive_jobs as archive_job
       set status = 'CANCELLED', worker_subject = null, claim_token = null,
           lease_expires_at = null, last_error_code = 'CREDENTIAL_ROTATED',
           completed_at = statement_timestamp(), updated_at = statement_timestamp()
     where archive_job.tenant_id = p_tenant_id
       and archive_job.connection_id = v_connection_id
       and archive_job.credential_version = v_current_version
       and archive_job.status not in ('CSV_REQUIRED', 'STAGED', 'FAILED', 'CANCELLED');
    update private.rv2_sync_jobs as j
       set status = 'CANCELLED', completed_at = statement_timestamp(),
           last_error_code = 'CREDENTIAL_ROTATED'
     where j.tenant_id = p_tenant_id
       and j.connection_id = v_connection_id
       and j.credential_version = v_current_version
       and j.status in ('QUEUED', 'CLAIMED');
    update public.rv2_connections as c
       set provider_scope_hash = p_provider_scope_hash,
           credential_version = v_next_version,
           status = v_status,
           permission_state = p_permission_state,
           permission_evidence = p_permission_evidence,
           consent_version = p_consent_version,
           verified_at = v_verified_at,
           next_due_at = case when v_status = 'ACTIVE' then statement_timestamp() else null end,
           last_error_code = null,
           disconnect_receipt_id = null,
           disconnected_at = null,
           updated_at = statement_timestamp()
     where c.tenant_id = p_tenant_id
       and c.connection_id = v_connection_id;
  end if;

  insert into private.rv2_credential_envelopes (
    tenant_id, connection_id, credential_version, operation,
    envelope_ciphertext, envelope_nonce, envelope_key_ref, envelope_sha256,
    idempotency_key, request_fingerprint, permission_state, permission_evidence,
    consent_version, result_status, verified_at, created_by
  ) values (
    p_tenant_id, v_connection_id, v_next_version, v_operation,
    p_envelope_ciphertext, p_envelope_nonce, p_envelope_key_ref, p_envelope_sha256,
    p_idempotency_key, p_request_fingerprint, p_permission_state, p_permission_evidence,
    p_consent_version, v_status, v_verified_at, p_subject
  );

  return query select
    v_connection_id, v_next_version, v_status, p_permission_state,
    p_permission_evidence, v_verified_at, v_operation = 'CREATE';
end
$function$;

create function public.rv2_enqueue_sync(
  p_connection_id uuid,
  p_dataset text,
  p_partition_key text,
  p_idempotency_key uuid
)
returns table (
  job_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_subject uuid := auth.uid();
  v_credential_version bigint;
  v_job_id uuid;
  v_status text;
  v_request_fingerprint text;
  v_existing_fingerprint text;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  if p_dataset not in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
     or p_partition_key !~ '^[A-Za-z0-9._:/-]{1,128}$'
     or p_idempotency_key is null then
    raise exception 'sync request rejected' using errcode = '22023';
  end if;
  select c.credential_version into v_credential_version
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  v_request_fingerprint := encode(extensions.digest(convert_to(
    'rv2-enqueue/1' || chr(0) || v_tenant_id::text || chr(0)
    || p_connection_id::text || chr(0) || p_dataset || chr(0) || p_partition_key,
    'utf8'
  ), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-enqueue:' || v_tenant_id::text || ':' || p_idempotency_key::text,
    0
  ));

  select j.job_id, j.status, j.request_fingerprint
    into v_job_id, v_status, v_existing_fingerprint
    from private.rv2_sync_jobs as j
   where j.tenant_id = v_tenant_id
     and j.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key reused with different request' using errcode = 'P0006';
    end if;
    return query select v_job_id, v_status;
    return;
  end if;

  insert into private.rv2_sync_partitions (
    tenant_id, connection_id, dataset, partition_key
  ) values (
    v_tenant_id, p_connection_id, p_dataset, p_partition_key
  ) on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;

  v_job_id := gen_random_uuid();
  insert into private.rv2_sync_jobs (
    tenant_id, job_id, connection_id, credential_version, requested_by,
    dataset, partition_key, queue_class, idempotency_key, request_fingerprint
  ) values (
    v_tenant_id, v_job_id, p_connection_id, v_credential_version, v_subject,
    p_dataset, p_partition_key, 'INTERACTIVE', p_idempotency_key, v_request_fingerprint
  );
  return query select v_job_id, 'QUEUED'::text;
end
$function$;

create function public.rv2_list_connections()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connections jsonb;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  select coalesce(jsonb_agg(jsonb_build_object(
           'connectionId', c.connection_id,
           'status', c.status,
           'credentialVersion', c.credential_version,
           'lastTrustedAt', c.last_trusted_at,
           'nextDueAt', c.next_due_at,
           'permissionState', c.permission_state,
           'permissionEvidence', c.permission_evidence,
           'lastErrorCode', c.last_error_code
         ) order by c.created_at, c.connection_id), '[]'::jsonb)
    into v_connections
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id;
  return jsonb_build_object(
    'format', 'rv-binance-connections/1',
    'connections', v_connections
  );
end
$function$;

create function public.rv2_get_dataset_status(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connection record;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  select c.* into v_connection
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'format', 'rv-binance-connection-status/1',
    'connectionId', v_connection.connection_id,
    'status', v_connection.status,
    'credentialVersion', v_connection.credential_version,
    'lastTrustedAt', v_connection.last_trusted_at,
    'nextDueAt', v_connection.next_due_at,
    'permissionState', v_connection.permission_state,
    'permissionEvidence', v_connection.permission_evidence,
    'lastErrorCode', v_connection.last_error_code,
    'currentGeneration', v_connection.current_generation,
    'coverage', private.rv2_coverage_document(v_tenant_id, p_connection_id)
  );
end
$function$;

create function public.rv2_get_current_dataset(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connection record;
  v_generation record;
  v_trades jsonb := '[]'::jsonb;
  v_income jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_algo_orders jsonb := '[]'::jsonb;
  v_force_orders jsonb := '[]'::jsonb;
  v_balances jsonb := '[]'::jsonb;
  v_positions jsonb := '[]'::jsonb;
  v_trade_models jsonb := '[]'::jsonb;
  v_reviews jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_journal jsonb := '[]'::jsonb;
  v_risk jsonb := '[]'::jsonb;
  v_reports jsonb := '[]'::jsonb;
  v_partial_as_of timestamptz;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  select c.* into v_connection
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  if v_connection.current_generation > 0 then
    select g.* into v_generation
      from public.rv2_generations as g
     where g.tenant_id = v_tenant_id
       and g.connection_id = p_connection_id
       and g.generation = v_connection.current_generation
       and g.status = 'PUBLISHED';
    if not found then
      raise exception 'current generation unavailable' using errcode = '55000';
    end if;
    select
      coalesce(
        jsonb_agg(jsonb_build_object(
          'id', e.event_body ->> 'id', 'symbol', e.event_body ->> 'symbol',
          'side', e.event_body ->> 'side',
          'positionSide', coalesce(e.event_body ->> 'positionSide', 'BOTH'),
          'time', (e.event_body ->> 'time')::bigint,
          'price', e.event_body ->> 'price', 'qty', e.event_body ->> 'qty',
          'commission', e.event_body ->> 'commission',
          'commissionAsset', e.event_body ->> 'commissionAsset',
          'realizedPnl', e.event_body ->> 'realizedPnl',
          'realizedPnlAsset', e.event_body ->> 'realizedPnlAsset'
        ) order by e.event_time, e.event_id)
          filter (where e.dataset = 'fills'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'income'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'orders'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'algo_orders'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'force_orders'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'balances'),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(e.event_body order by e.event_time, e.event_id)
          filter (where e.dataset = 'positions'),
        '[]'::jsonb
      )
      into v_trades, v_income, v_orders, v_algo_orders, v_force_orders, v_balances, v_positions
      from public.rv2_source_events as e
     where e.tenant_id = v_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions')
       and e.source_observed_at <= v_generation.published_at;
  else
    -- A generation is required before any analytics capability can be opened,
    -- but committed immutable records remain browsable under PARTIAL/UNKNOWN.
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', e.event_body ->> 'id', 'symbol', e.event_body ->> 'symbol',
        'side', e.event_body ->> 'side',
        'positionSide', coalesce(e.event_body ->> 'positionSide', 'BOTH'),
        'time', (e.event_body ->> 'time')::bigint,
        'price', e.event_body ->> 'price', 'qty', e.event_body ->> 'qty',
        'commission', e.event_body ->> 'commission',
        'commissionAsset', e.event_body ->> 'commissionAsset',
        'realizedPnl', e.event_body ->> 'realizedPnl',
        'realizedPnlAsset', e.event_body ->> 'realizedPnlAsset'
      ) order by e.event_time, e.event_id)
        filter (where e.dataset = 'fills'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'income'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'orders'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'algo_orders'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'force_orders'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'balances'), '[]'::jsonb),
      coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id)
        filter (where e.dataset = 'positions'), '[]'::jsonb),
      max(e.source_observed_at)
      into v_trades, v_income, v_orders, v_algo_orders, v_force_orders,
           v_balances, v_positions, v_partial_as_of
      from public.rv2_source_events as e
     where e.tenant_id = v_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset in ('fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reviewId', r.review_id,
           'tradeId', r.trade_id,
           'version', r.version,
           'updatedAt', r.updated_at,
           'payload', r.payload
         ) order by r.updated_at, r.review_id), '[]'::jsonb)
    into v_reviews
    from public.rv2_reviews as r
    join public.rv2_trade_read_models as m
      on m.tenant_id = r.tenant_id
     and m.connection_id = r.connection_id
     and m.trade_id = r.trade_id
     and m.generation = v_connection.current_generation
    join public.rv2_trade_identities as i
      on i.tenant_id = m.tenant_id
     and i.connection_id = m.connection_id
     and i.trade_id = m.trade_id
   where r.tenant_id = v_tenant_id
     and r.connection_id = p_connection_id
     and r.source_lineage_sha256 = i.source_lineage_sha256;

  if v_connection.current_generation > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'tradeId', m.trade_id,
             'generation', m.generation,
             'payload', m.payload,
             'payloadSha256', m.payload_sha256
           ) order by (m.payload ->> 'exitTime')::bigint, m.trade_id), '[]'::jsonb)
      into v_trade_models
      from public.rv2_trade_read_models as m
     where m.tenant_id = v_tenant_id
       and m.connection_id = p_connection_id
       and m.generation = v_connection.current_generation;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'actionId', a.action_id, 'reviewId', a.review_id, 'tradeId', a.trade_id,
           'status', a.status, 'version', a.version, 'payload', a.payload,
           'createdAt', a.created_at, 'updatedAt', a.updated_at
         ) order by a.created_at, a.action_id), '[]'::jsonb)
    into v_actions
    from public.rv2_actions as a
    join public.rv2_reviews as r
      on r.tenant_id = a.tenant_id
     and r.connection_id = a.connection_id
     and r.review_id = a.review_id
     and r.trade_id = a.trade_id
    join public.rv2_trade_read_models as m
      on m.tenant_id = r.tenant_id
     and m.connection_id = r.connection_id
     and m.trade_id = r.trade_id
     and m.generation = v_connection.current_generation
    join public.rv2_trade_identities as i
      on i.tenant_id = m.tenant_id
     and i.connection_id = m.connection_id
     and i.trade_id = m.trade_id
   where a.tenant_id = v_tenant_id and a.connection_id = p_connection_id
     and r.source_lineage_sha256 = i.source_lineage_sha256;
  select coalesce(jsonb_agg(jsonb_build_object(
           'journalId', j.journal_id, 'day', j.journal_day, 'version', j.version,
           'payload', j.payload, 'createdAt', j.created_at, 'updatedAt', j.updated_at
         ) order by j.journal_day, j.journal_id), '[]'::jsonb)
    into v_journal
    from public.rv2_journal_entries as j
   where j.tenant_id = v_tenant_id and j.connection_id = p_connection_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'ruleId', r.rule_id, 'status', r.status, 'version', r.version,
           'payload', r.payload, 'createdAt', r.created_at, 'updatedAt', r.updated_at
         ) order by r.created_at, r.rule_id), '[]'::jsonb)
    into v_risk
    from public.rv2_risk_rules as r
   where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'reportId', r.report_id, 'reportType', r.report_type,
           'periodStart', r.period_start, 'periodEnd', r.period_end,
           'sourceGeneration', r.source_generation, 'version', r.version,
           'payload', r.payload, 'createdAt', r.created_at, 'updatedAt', r.updated_at
         ) order by r.period_start, r.report_id), '[]'::jsonb)
    into v_reports
    from public.rv2_reports as r
   where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id;

  if v_connection.current_generation = 0 then
    return jsonb_build_object(
      'format', 'rv-cloud-dataset/1',
      'generation', 0,
      'asOf', coalesce(v_partial_as_of, v_connection.created_at),
      'coverage', private.rv2_coverage_document(v_tenant_id, p_connection_id),
      'reconciliation', private.rv2_default_reconciliation(),
      'capabilities', private.rv2_default_capabilities(),
      'trades', v_trades,
      'income', v_income,
      'orders', v_orders,
      'algoOrders', v_algo_orders,
      'forceOrders', v_force_orders,
      'balances', v_balances,
      'positions', v_positions,
      'tradeModels', v_trade_models,
      'reviews', v_reviews,
      'actions', v_actions,
      'journal', v_journal,
      'risk', v_risk,
      'reports', v_reports
    );
  end if;

  return jsonb_build_object(
    'format', 'rv-cloud-dataset/1',
    'generation', v_generation.generation,
    'asOf', v_generation.published_at,
    'coverage', v_generation.coverage,
    'reconciliation', v_generation.reconciliation,
    'capabilities', v_generation.capabilities,
    'trades', v_trades,
    'income', v_income,
    'orders', v_orders,
    'algoOrders', v_algo_orders,
    'forceOrders', v_force_orders,
    'balances', v_balances,
    'positions', v_positions,
    'tradeModels', v_trade_models,
    'reviews', v_reviews,
    'actions', v_actions,
    'journal', v_journal,
    'risk', v_risk,
    'reports', v_reports
  );
end
$function$;

create function public.rv2_get_trades(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connection record;
  v_generation record;
  v_items jsonb := '[]'::jsonb;
  v_partial_as_of timestamptz;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  select c.* into v_connection
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_connection.current_generation > 0 then
    select g.* into v_generation
      from public.rv2_generations as g
     where g.tenant_id = v_tenant_id
       and g.connection_id = p_connection_id
       and g.generation = v_connection.current_generation
       and g.status = 'PUBLISHED';
    if not found then
      raise exception 'current generation unavailable' using errcode = '55000';
    end if;
    select coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id), '[]'::jsonb)
      into v_items
      from public.rv2_source_events as e
     where e.tenant_id = v_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset = 'fills'
       and e.source_observed_at <= v_generation.published_at;
  else
    select coalesce(jsonb_agg(e.event_body order by e.event_time, e.event_id), '[]'::jsonb),
           max(e.source_observed_at)
      into v_items, v_partial_as_of
      from public.rv2_source_events as e
     where e.tenant_id = v_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset = 'fills';
  end if;
  return jsonb_build_object(
    'format', 'rv-cloud-trades/1',
    'generation', v_connection.current_generation,
    'asOf', coalesce(v_generation.published_at, v_partial_as_of, v_connection.created_at),
    'trades', v_items
  );
end
$function$;

create function public.rv2_get_reviews(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connection record;
  v_items jsonb;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  select c.* into v_connection
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'reviewId', r.review_id,
           'tradeId', r.trade_id,
           'version', r.version,
           'payload', r.payload,
           'updatedAt', r.updated_at
         ) order by r.updated_at, r.review_id), '[]'::jsonb)
    into v_items
    from public.rv2_reviews as r
    join public.rv2_trade_read_models as m
      on m.tenant_id = r.tenant_id
     and m.connection_id = r.connection_id
     and m.trade_id = r.trade_id
     and m.generation = v_connection.current_generation
    join public.rv2_trade_identities as i
      on i.tenant_id = m.tenant_id
     and i.connection_id = m.connection_id
     and i.trade_id = m.trade_id
   where r.tenant_id = v_tenant_id
     and r.connection_id = p_connection_id
     and r.source_lineage_sha256 = i.source_lineage_sha256;
  return jsonb_build_object('format', 'rv-cloud-reviews/1', 'reviews', v_items);
end
$function$;

create function public.rv2_upsert_review(
  p_connection_id uuid,
  p_trade_id text,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_payload jsonb
)
returns table (
  review_id uuid,
  trade_id text,
  version bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_subject uuid := auth.uid();
  v_review record;
  v_request record;
  v_payload_sha256 text;
  v_request_fingerprint text;
  v_result_snapshot jsonb;
  v_connection record;
  v_trade_model record;
  v_action record;
  v_lesson text;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  if p_trade_id is null or p_trade_id !~ '^t_[0-9a-f]{16}$'
     or coalesce(p_expected_version, -1) < 0
     or p_idempotency_key is null
     or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 4096
     or not (p_payload ?& array['saw', 'happened', 'lesson', 'grade', 'reviewed'])
     or (select count(*) from jsonb_object_keys(p_payload)) <> 5
     or jsonb_typeof(p_payload -> 'saw') <> 'string'
     or jsonb_typeof(p_payload -> 'happened') <> 'string'
     or jsonb_typeof(p_payload -> 'lesson') <> 'string'
     or length(p_payload ->> 'saw') > 600
     or length(p_payload ->> 'happened') > 600
     or length(p_payload ->> 'lesson') > 600
     or p_payload ->> 'grade' not in ('A', 'B', 'C', 'D')
     or jsonb_typeof(p_payload -> 'reviewed') <> 'boolean'
     or private.rv2_payload_has_credential_key(p_payload) then
    raise exception 'review request rejected' using errcode = '22023';
  end if;
  v_payload_sha256 := encode(extensions.digest(convert_to(p_payload::text, 'utf8'), 'sha256'), 'hex');
  v_request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'connectionId', p_connection_id,
    'tradeId', p_trade_id,
    'expectedVersion', p_expected_version,
    'payloadSha256', v_payload_sha256
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-review:' || v_tenant_id::text || ':' || p_idempotency_key::text,
    0
  ));
  select q.* into v_request
    from private.rv2_review_requests as q
   where q.tenant_id = v_tenant_id
     and q.connection_id = p_connection_id
     and q.idempotency_key = p_idempotency_key;
  if found then
    if v_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    select r.* into v_review
      from public.rv2_reviews as r
     where r.review_id = v_request.review_id
       and r.tenant_id = v_tenant_id
       and r.connection_id = p_connection_id;
    if not found then
      raise exception 'review idempotency receipt unavailable' using errcode = '55000';
    end if;
    return query select
      v_request.review_id, v_request.trade_id,
      v_request.resulting_version, v_request.resulting_updated_at;
    return;
  end if;

  select c.* into v_connection from public.rv2_connections as c
   where c.tenant_id = v_tenant_id and c.connection_id = p_connection_id;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select m.*, i.source_lineage_sha256 into v_trade_model
    from public.rv2_trade_read_models as m
    join public.rv2_trade_identities as i
      on i.tenant_id = m.tenant_id
     and i.connection_id = m.connection_id
     and i.trade_id = m.trade_id
   where m.tenant_id = v_tenant_id
     and m.connection_id = p_connection_id
     and m.trade_id = p_trade_id
     and m.generation = v_connection.current_generation;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  -- Different idempotency keys racing to create the same first review must
  -- serialize on the trade identity. The loser observes version 1 and gets the
  -- documented 40001 CAS result instead of leaking a raw unique violation.
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-review-trade:' || v_tenant_id::text || ':'
    || p_connection_id::text || ':' || p_trade_id,
    0
  ));
  select r.* into v_review
    from public.rv2_reviews as r
   where r.tenant_id = v_tenant_id
     and r.connection_id = p_connection_id
     and r.trade_id = p_trade_id
   for update;

  if not found then
    if p_expected_version <> 0 then
      raise exception 'review version conflict' using errcode = '40001';
    end if;
    insert into public.rv2_reviews (
      tenant_id, connection_id, trade_id, trade_generation,
      source_lineage_sha256, payload, payload_sha256, created_by
    ) values (
      v_tenant_id, p_connection_id, p_trade_id, v_connection.current_generation,
      v_trade_model.source_lineage_sha256, p_payload, v_payload_sha256, v_subject
    ) returning * into v_review;
  elsif v_review.version <> p_expected_version then
    raise exception 'review version conflict' using errcode = '40001';
  elsif v_review.source_lineage_sha256 <> v_trade_model.source_lineage_sha256 then
    raise exception 'review trade lineage conflict' using errcode = '40001';
  else
    update public.rv2_reviews as r
       set version = r.version + 1,
           trade_generation = v_connection.current_generation,
           payload = p_payload,
           payload_sha256 = v_payload_sha256,
           updated_at = statement_timestamp()
     where r.review_id = v_review.review_id
     returning * into v_review;
  end if;
  -- A lesson-backed action is part of the same review transaction. Existing
  -- experiment/status fields are never overwritten by ledger or review-model
  -- regeneration; only a changed lesson updates the action text.
  v_lesson := trim(p_payload ->> 'lesson');
  if length(v_lesson) > 0 then
    select a.* into v_action
      from public.rv2_actions as a
     where a.tenant_id = v_tenant_id
       and a.connection_id = p_connection_id
       and a.review_id = v_review.review_id
     for update;
    if not found then
      insert into public.rv2_actions (
        tenant_id, connection_id, review_id, trade_id, status,
        payload, created_by
      ) values (
        v_tenant_id, p_connection_id, v_review.review_id, p_trade_id, 'OPEN',
        jsonb_build_object('text', v_lesson, 'experiment', null), v_subject
      );
    elsif v_action.payload ->> 'text' is distinct from v_lesson then
      update public.rv2_actions as a
         set version = a.version + 1,
             payload = jsonb_set(a.payload, '{text}', to_jsonb(v_lesson), true),
             updated_at = statement_timestamp()
       where a.tenant_id = v_tenant_id
         and a.connection_id = p_connection_id
         and a.action_id = v_action.action_id;
    end if;
  end if;
  v_result_snapshot := jsonb_build_object(
    'reviewId', v_review.review_id,
    'tradeId', v_review.trade_id,
    'version', v_review.version,
    'updatedAt', v_review.updated_at,
    'payloadSha256', v_review.payload_sha256
  );
  insert into private.rv2_review_requests (
    tenant_id, connection_id, idempotency_key, trade_id, request_fingerprint,
    review_id, resulting_version, resulting_updated_at, result_snapshot, created_by
  ) values (
    v_tenant_id, p_connection_id, p_idempotency_key, p_trade_id,
    v_request_fingerprint, v_review.review_id, v_review.version,
    v_review.updated_at, v_result_snapshot, v_subject
  );
  return query select v_review.review_id, v_review.trade_id, v_review.version, v_review.updated_at;
end
$function$;

create function public.rv2_upsert_action(
  p_connection_id uuid,
  p_action_id uuid,
  p_review_id uuid,
  p_trade_id text,
  p_status text,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_payload jsonb
)
returns table (resource_id text, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid := private.rv2_require_browser_tenant();
  v_subject uuid := auth.uid();
  v_review record;
  v_action record;
  v_request record;
  v_request_fingerprint text;
  v_snapshot jsonb;
  v_action_exists boolean;
  v_experiment_changed boolean;
begin
  if p_action_id is null or p_review_id is null or p_trade_id !~ '^t_[0-9a-f]{16}$'
     or p_status not in ('OPEN', 'DONE', 'CANCELLED')
     or coalesce(p_expected_version, -1) < 0 or p_idempotency_key is null
     or jsonb_typeof(p_payload) <> 'object'
     or not (p_payload ?& array['text', 'experiment'])
     or (select count(*) from jsonb_object_keys(p_payload)) <> 2
     or jsonb_typeof(p_payload -> 'text') <> 'string'
     or length(trim(p_payload ->> 'text')) not between 1 and 600
     or jsonb_typeof(p_payload -> 'experiment') not in ('object', 'null')
     or octet_length(p_payload::text) > 65536
     or private.rv2_payload_has_credential_key(p_payload) then
    raise exception 'action request rejected' using errcode = '22023';
  end if;
  v_request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actionId', p_action_id, 'reviewId', p_review_id, 'tradeId', p_trade_id,
    'status', p_status, 'expectedVersion', p_expected_version, 'payload', p_payload
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-domain:' || v_tenant_id::text || ':ACTION:' || p_idempotency_key::text, 0
  ));
  select q.* into v_request from private.rv2_domain_mutation_requests as q
   where q.tenant_id = v_tenant_id and q.connection_id = p_connection_id
     and q.resource_kind = 'ACTION' and q.idempotency_key = p_idempotency_key;
  if found then
    if v_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'action idempotency conflict' using errcode = '22023';
    end if;
    perform 1 from public.rv2_actions as a
     where a.tenant_id = v_tenant_id and a.connection_id = p_connection_id
       and a.action_id::text = v_request.resource_id;
    if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
    return query select v_request.resource_id, v_request.resulting_version,
      v_request.resulting_updated_at;
    return;
  end if;
  select r.* into v_review
    from public.rv2_reviews as r
   where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
     and r.review_id = p_review_id and r.trade_id = p_trade_id;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-action:' || v_tenant_id::text || ':' || p_action_id::text, 0
  ));
  select a.* into v_action from public.rv2_actions as a
   where a.tenant_id = v_tenant_id and a.connection_id = p_connection_id
     and a.action_id = p_action_id for update;
  v_action_exists := found;
  v_experiment_changed := case
    when not v_action_exists then p_payload -> 'experiment' <> 'null'::jsonb
    else p_payload -> 'experiment' is distinct from v_action.payload -> 'experiment'
  end;
  if v_experiment_changed then
    perform 1
      from public.rv2_connections as c
      join public.rv2_generations as g
        on g.tenant_id = c.tenant_id
       and g.connection_id = c.connection_id
       and g.generation = c.current_generation
       and g.status = 'PUBLISHED'
     where c.tenant_id = v_tenant_id
       and c.connection_id = p_connection_id
       and g.capabilities -> 'experiments' ->> 'decision' = 'ALLOW';
    if not found then
      raise exception 'action experiment unavailable' using errcode = '55000';
    end if;
  end if;
  if not v_action_exists then
    if p_expected_version <> 0 then raise exception 'action version conflict: 40001' using errcode = '40001'; end if;
    insert into public.rv2_actions (
      tenant_id, connection_id, action_id, review_id, trade_id, status, payload, created_by
    ) values (
      v_tenant_id, p_connection_id, p_action_id, p_review_id, p_trade_id,
      p_status, p_payload, v_subject
    ) returning * into v_action;
  elsif v_action.version <> p_expected_version
     or v_action.review_id <> p_review_id or v_action.trade_id <> p_trade_id then
    raise exception 'action version conflict: 40001' using errcode = '40001';
  else
    update public.rv2_actions as a set version = a.version + 1, status = p_status,
      payload = p_payload, updated_at = statement_timestamp()
     where a.tenant_id = v_tenant_id and a.connection_id = p_connection_id
       and a.action_id = p_action_id returning * into v_action;
  end if;
  v_snapshot := jsonb_build_object('resourceId', v_action.action_id, 'version', v_action.version,
    'updatedAt', v_action.updated_at);
  insert into private.rv2_domain_mutation_requests (
    tenant_id, connection_id, resource_kind, idempotency_key, resource_id,
    request_fingerprint, resulting_version, resulting_updated_at, result_snapshot, created_by
  ) values (
    v_tenant_id, p_connection_id, 'ACTION', p_idempotency_key, v_action.action_id::text,
    v_request_fingerprint, v_action.version, v_action.updated_at, v_snapshot, v_subject
  );
  return query select v_action.action_id::text, v_action.version, v_action.updated_at;
end
$function$;

create function public.rv2_upsert_journal(
  p_connection_id uuid,
  p_journal_day date,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_payload jsonb
)
returns table (resource_id text, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid := private.rv2_require_browser_tenant();
  v_subject uuid := auth.uid();
  v_entry record;
  v_request record;
  v_request_fingerprint text;
  v_snapshot jsonb;
begin
  if p_journal_day is null or coalesce(p_expected_version, -1) < 0
     or p_idempotency_key is null or jsonb_typeof(p_payload) <> 'object'
     or not (p_payload ?& array['note', 'emotion'])
     or (select count(*) from jsonb_object_keys(p_payload)) <> 2
     or jsonb_typeof(p_payload -> 'note') <> 'string'
     or jsonb_typeof(p_payload -> 'emotion') <> 'string'
     or length(p_payload ->> 'note') > 4000 or length(p_payload ->> 'emotion') > 80
     or octet_length(p_payload::text) > 8192
     or private.rv2_payload_has_credential_key(p_payload) then
    raise exception 'journal request rejected' using errcode = '22023';
  end if;
  v_request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'day', p_journal_day, 'expectedVersion', p_expected_version, 'payload', p_payload
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-domain:' || v_tenant_id::text || ':JOURNAL:' || p_idempotency_key::text, 0
  ));
  select q.* into v_request from private.rv2_domain_mutation_requests as q
   where q.tenant_id = v_tenant_id and q.connection_id = p_connection_id
     and q.resource_kind = 'JOURNAL' and q.idempotency_key = p_idempotency_key;
  if found then
    if v_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'journal idempotency conflict' using errcode = '22023';
    end if;
    perform 1 from public.rv2_journal_entries as j
     where j.tenant_id = v_tenant_id and j.connection_id = p_connection_id
       and j.journal_day::text = v_request.resource_id;
    if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
    return query select v_request.resource_id, v_request.resulting_version,
      v_request.resulting_updated_at;
    return;
  end if;
  perform 1 from public.rv2_connections as c
   where c.tenant_id = v_tenant_id and c.connection_id = p_connection_id;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-journal:' || v_tenant_id::text || ':' || p_journal_day::text, 0
  ));
  select j.* into v_entry from public.rv2_journal_entries as j
   where j.tenant_id = v_tenant_id and j.connection_id = p_connection_id
     and j.journal_day = p_journal_day for update;
  if not found then
    if p_expected_version <> 0 then raise exception 'journal version conflict: 40001' using errcode = '40001'; end if;
    insert into public.rv2_journal_entries (
      tenant_id, connection_id, journal_day, payload, created_by
    ) values (v_tenant_id, p_connection_id, p_journal_day, p_payload, v_subject)
    returning * into v_entry;
  elsif v_entry.version <> p_expected_version then
    raise exception 'journal version conflict: 40001' using errcode = '40001';
  else
    update public.rv2_journal_entries as j set version = j.version + 1,
      payload = p_payload, updated_at = statement_timestamp()
     where j.tenant_id = v_tenant_id and j.connection_id = p_connection_id
       and j.journal_day = p_journal_day returning * into v_entry;
  end if;
  v_snapshot := jsonb_build_object('resourceId', p_journal_day, 'version', v_entry.version,
    'updatedAt', v_entry.updated_at);
  insert into private.rv2_domain_mutation_requests (
    tenant_id, connection_id, resource_kind, idempotency_key, resource_id,
    request_fingerprint, resulting_version, resulting_updated_at, result_snapshot, created_by
  ) values (
    v_tenant_id, p_connection_id, 'JOURNAL', p_idempotency_key, p_journal_day::text,
    v_request_fingerprint, v_entry.version, v_entry.updated_at, v_snapshot, v_subject
  );
  return query select p_journal_day::text, v_entry.version, v_entry.updated_at;
end
$function$;

create function public.rv2_upsert_risk_rule(
  p_connection_id uuid,
  p_rule_id uuid,
  p_status text,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_payload jsonb
)
returns table (resource_id text, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid := private.rv2_require_browser_tenant();
  v_subject uuid := auth.uid();
  v_rule record;
  v_request record;
  v_request_fingerprint text;
  v_snapshot jsonb;
begin
  if p_rule_id is null or p_status not in ('ACTIVE', 'PAUSED', 'RETIRED')
     or coalesce(p_expected_version, -1) < 0 or p_idempotency_key is null
     or jsonb_typeof(p_payload) <> 'object'
     or not (p_payload ?& array['text', 'active'])
     or (select count(*) from jsonb_object_keys(p_payload)) <> 2
     or jsonb_typeof(p_payload -> 'text') <> 'string'
     or length(trim(p_payload ->> 'text')) not between 1 and 600
     or jsonb_typeof(p_payload -> 'active') <> 'boolean'
     or ((p_payload ->> 'active')::boolean is distinct from (p_status = 'ACTIVE'))
     or octet_length(p_payload::text) > 4096
     or private.rv2_payload_has_credential_key(p_payload) then
    raise exception 'risk rule request rejected' using errcode = '22023';
  end if;
  v_request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'ruleId', p_rule_id, 'status', p_status,
    'expectedVersion', p_expected_version, 'payload', p_payload
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-domain:' || v_tenant_id::text || ':RISK:' || p_idempotency_key::text, 0
  ));
  select q.* into v_request from private.rv2_domain_mutation_requests as q
   where q.tenant_id = v_tenant_id and q.connection_id = p_connection_id
     and q.resource_kind = 'RISK' and q.idempotency_key = p_idempotency_key;
  if found then
    if v_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'risk idempotency conflict' using errcode = '22023';
    end if;
    perform 1 from public.rv2_risk_rules as r
     where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
       and r.rule_id::text = v_request.resource_id;
    if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
    return query select v_request.resource_id, v_request.resulting_version,
      v_request.resulting_updated_at;
    return;
  end if;
  perform 1 from public.rv2_connections as c
   where c.tenant_id = v_tenant_id and c.connection_id = p_connection_id;
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-risk:' || v_tenant_id::text || ':' || p_rule_id::text, 0
  ));
  select r.* into v_rule from public.rv2_risk_rules as r
   where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
     and r.rule_id = p_rule_id for update;
  if not found then
    if p_expected_version <> 0 then raise exception 'risk version conflict: 40001' using errcode = '40001'; end if;
    insert into public.rv2_risk_rules (
      tenant_id, connection_id, rule_id, status, payload, created_by
    ) values (v_tenant_id, p_connection_id, p_rule_id, p_status, p_payload, v_subject)
    returning * into v_rule;
  elsif v_rule.version <> p_expected_version then
    raise exception 'risk version conflict: 40001' using errcode = '40001';
  else
    update public.rv2_risk_rules as r set version = r.version + 1,
      status = p_status, payload = p_payload, updated_at = statement_timestamp()
     where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
       and r.rule_id = p_rule_id returning * into v_rule;
  end if;
  v_snapshot := jsonb_build_object('resourceId', v_rule.rule_id, 'version', v_rule.version,
    'updatedAt', v_rule.updated_at);
  insert into private.rv2_domain_mutation_requests (
    tenant_id, connection_id, resource_kind, idempotency_key, resource_id,
    request_fingerprint, resulting_version, resulting_updated_at, result_snapshot, created_by
  ) values (
    v_tenant_id, p_connection_id, 'RISK', p_idempotency_key, v_rule.rule_id::text,
    v_request_fingerprint, v_rule.version, v_rule.updated_at, v_snapshot, v_subject
  );
  return query select v_rule.rule_id::text, v_rule.version, v_rule.updated_at;
end
$function$;

create function public.rv2_upsert_report(
  p_connection_id uuid,
  p_report_type text,
  p_period_start date,
  p_period_end date,
  p_source_generation bigint,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_payload jsonb
)
returns table (resource_id text, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid := private.rv2_require_browser_tenant();
  v_subject uuid := auth.uid();
  v_connection record;
  v_report record;
  v_request record;
  v_request_fingerprint text;
  v_payload_sha256 text;
  v_snapshot jsonb;
begin
  if p_report_type not in ('WEEKLY', 'MONTHLY') or p_period_start is null
     or p_period_end is null or p_period_end < p_period_start
     or coalesce(p_source_generation, 0) <= 0 or coalesce(p_expected_version, -1) < 0
     or p_idempotency_key is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 262144
     or private.rv2_payload_has_credential_key(p_payload) then
    raise exception 'report request rejected' using errcode = '22023';
  end if;
  v_payload_sha256 := encode(extensions.digest(convert_to(p_payload::text, 'utf8'), 'sha256'), 'hex');
  v_request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'reportType', p_report_type, 'periodStart', p_period_start, 'periodEnd', p_period_end,
    'sourceGeneration', p_source_generation, 'expectedVersion', p_expected_version,
    'payloadSha256', v_payload_sha256
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-domain:' || v_tenant_id::text || ':REPORT:' || p_idempotency_key::text, 0
  ));
  select q.* into v_request from private.rv2_domain_mutation_requests as q
   where q.tenant_id = v_tenant_id and q.connection_id = p_connection_id
     and q.resource_kind = 'REPORT' and q.idempotency_key = p_idempotency_key;
  if found then
    if v_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'report idempotency conflict' using errcode = '22023';
    end if;
    perform 1 from public.rv2_reports as r
     where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
       and r.report_id::text = v_request.resource_id;
    if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
    return query select v_request.resource_id, v_request.resulting_version,
      v_request.resulting_updated_at;
    return;
  end if;
  select c.* into v_connection from public.rv2_connections as c
   where c.tenant_id = v_tenant_id and c.connection_id = p_connection_id;
  if not found or v_connection.current_generation <> p_source_generation then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1 from public.rv2_generations as g
   where g.tenant_id = v_tenant_id and g.connection_id = p_connection_id
     and g.generation = p_source_generation and g.status = 'PUBLISHED';
  if not found then raise exception 'resource not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-report:' || v_tenant_id::text || ':' || p_report_type || ':'
      || p_period_start::text || ':' || p_period_end::text, 0
  ));
  select r.* into v_report from public.rv2_reports as r
   where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
     and r.report_type = p_report_type and r.period_start = p_period_start
     and r.period_end = p_period_end for update;
  if not found then
    if p_expected_version <> 0 then raise exception 'report version conflict: 40001' using errcode = '40001'; end if;
    insert into public.rv2_reports (
      tenant_id, connection_id, report_type, period_start, period_end,
      source_generation, payload, payload_sha256, created_by
    ) values (
      v_tenant_id, p_connection_id, p_report_type, p_period_start, p_period_end,
      p_source_generation, p_payload, v_payload_sha256, v_subject
    ) returning * into v_report;
  elsif v_report.version <> p_expected_version then
    raise exception 'report version conflict: 40001' using errcode = '40001';
  else
    update public.rv2_reports as r set version = r.version + 1,
      source_generation = p_source_generation, payload = p_payload,
      payload_sha256 = v_payload_sha256, updated_at = statement_timestamp()
     where r.tenant_id = v_tenant_id and r.connection_id = p_connection_id
       and r.report_id = v_report.report_id returning * into v_report;
  end if;
  v_snapshot := jsonb_build_object('resourceId', v_report.report_id, 'version', v_report.version,
    'updatedAt', v_report.updated_at);
  insert into private.rv2_domain_mutation_requests (
    tenant_id, connection_id, resource_kind, idempotency_key, resource_id,
    request_fingerprint, resulting_version, resulting_updated_at, result_snapshot, created_by
  ) values (
    v_tenant_id, p_connection_id, 'REPORT', p_idempotency_key, v_report.report_id::text,
    v_request_fingerprint, v_report.version, v_report.updated_at, v_snapshot, v_subject
  );
  return query select v_report.report_id::text, v_report.version, v_report.updated_at;
end
$function$;

create function public.rv2_disconnect_connection(
  p_connection_id uuid,
  p_expected_credential_version bigint
)
returns table (
  connection_id uuid,
  status text,
  receipt_id uuid,
  disconnected_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant_id uuid;
  v_connection record;
begin
  v_tenant_id := private.rv2_require_browser_tenant();
  perform 1
    from public.rv2_memberships as m
   where m.tenant_id = v_tenant_id
     and m.user_id = auth.uid()
     and m.status = 'ACTIVE'
     and m.member_role = 'OWNER';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select c.* into v_connection
    from public.rv2_connections as c
   where c.tenant_id = v_tenant_id
     and c.connection_id = p_connection_id
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_connection.credential_version <> p_expected_credential_version then
    raise exception 'credential version conflict' using errcode = '40001';
  end if;
  if v_connection.status <> 'REVOKED' then
    update public.rv2_connections as c
       set status = 'REVOKED',
           disconnect_receipt_id = gen_random_uuid(),
           disconnected_at = statement_timestamp(),
           next_due_at = null,
           updated_at = statement_timestamp()
     where c.tenant_id = v_tenant_id
       and c.connection_id = p_connection_id
     returning * into v_connection;
    update private.rv2_sync_jobs as j
       set status = 'CANCELLED', completed_at = statement_timestamp()
     where j.tenant_id = v_tenant_id
       and j.connection_id = p_connection_id
       and j.status in ('QUEUED', 'CLAIMED');
    update private.rv2_sync_attempts as a
       set status = 'FAILED', error_code = 'CONNECTION_REVOKED',
           completed_at = statement_timestamp()
     where a.tenant_id = v_tenant_id
       and a.job_id in (
         select j.job_id from private.rv2_sync_jobs as j
          where j.tenant_id = v_tenant_id
            and j.connection_id = p_connection_id
            and j.status = 'CANCELLED'
       )
       and a.status = 'CLAIMED';
    update private.rv2_post_commit_work as w
       set status = 'FAILED', worker_subject = null, lease_token = null,
           lease_expires_at = null, last_error_code = 'CONNECTION_REVOKED',
           completed_at = statement_timestamp()
     where w.tenant_id = v_tenant_id
       and w.connection_id = p_connection_id
       and w.status in ('PENDING', 'CLAIMED');
    update private.rv2_archive_jobs as archive_job
       set status = 'CANCELLED', worker_subject = null, claim_token = null,
           lease_expires_at = null, last_error_code = 'CONNECTION_REVOKED',
           completed_at = statement_timestamp(), updated_at = statement_timestamp()
     where archive_job.tenant_id = v_tenant_id
       and archive_job.connection_id = p_connection_id
       and archive_job.status not in ('CSV_REQUIRED', 'STAGED', 'FAILED', 'CANCELLED');
    update private.rv2_credential_envelopes as e
       set retired_at = coalesce(e.retired_at, statement_timestamp())
     where e.tenant_id = v_tenant_id
       and e.connection_id = p_connection_id
       and e.retired_at is null;
  end if;
  return query select
    v_connection.connection_id,
    v_connection.status,
    v_connection.disconnect_receipt_id,
    v_connection.disconnected_at;
end
$function$;

create function private.rv2_clear_subject_business_data(
  p_subject uuid,
  p_operation text,
  p_receipt_id uuid
)
returns table (
  receipt_id uuid,
  deleted_at timestamptz,
  backup_purge_after timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_membership record;
  v_existing record;
  v_deleted_at timestamptz := statement_timestamp();
  v_backup_purge_after timestamptz := statement_timestamp() + interval '30 days';
begin
  if p_subject is null or p_receipt_id is null
     or p_operation not in ('CLEAR_BUSINESS_DATA', 'DELETE_ACCOUNT') then
    raise exception 'destructive operation rejected' using errcode = '22023';
  end if;
  select d.* into v_existing
    from private.rv2_deletion_tombstones as d
   where d.receipt_id = p_receipt_id;
  if found then
    if v_existing.subject_id <> p_subject or v_existing.operation <> p_operation then
      raise exception 'destructive receipt conflict' using errcode = '40001';
    end if;
    return query select
      v_existing.receipt_id, v_existing.deleted_at, v_existing.backup_purge_after;
    return;
  end if;

  select m.* into v_membership
    from public.rv2_memberships as m
   where m.user_id = p_subject
     and m.status = 'ACTIVE'
   for update;
  if not found then
    -- Pre-rv2 users have no rv2 plane to clear. The legacy deletion receipt is
    -- still authoritative and no synthetic tenant is created here.
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-destructive:' || v_membership.tenant_id::text,
    0
  ));
  if v_membership.member_role = 'OWNER' then
    null;
  else
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  delete from private.rv2_egress_receipts as e
   where e.tenant_id = v_membership.tenant_id;
  delete from private.rv2_backup_runs as b
   where b.tenant_id = v_membership.tenant_id;
  -- The personal Beta has one OWNER per tenant. Cascades cancel sync jobs,
  -- destroy credential envelopes, and remove all domain rows for that owner.
  delete from public.rv2_connections as c
   where c.tenant_id = v_membership.tenant_id;

  insert into private.rv2_deletion_tombstones (
    tenant_id, receipt_id, subject_id, operation, deleted_at, backup_purge_after
  ) values (
    v_membership.tenant_id, p_receipt_id, p_subject, p_operation,
    v_deleted_at, v_backup_purge_after
  );

  if p_operation = 'DELETE_ACCOUNT' then
    update public.rv2_memberships as m
       set status = 'DELETED',
           membership_version = m.membership_version + 1,
           updated_at = v_deleted_at
     where m.tenant_id = v_membership.tenant_id
       and m.user_id = p_subject;
    update public.rv2_tenants as t
       set status = 'DELETED',
           deletion_receipt_id = p_receipt_id,
           deleted_at = v_deleted_at
     where t.tenant_id = v_membership.tenant_id;
  end if;
  return query select p_receipt_id, v_deleted_at, v_backup_purge_after;
end
$function$;

-- Extend the reviewed OTP/capability deletion transaction instead of exposing
-- a second browser deletion primitive that could bypass recent re-auth.
create or replace function public.rv_service_execute_business_deletion(
  p_subject uuid,
  p_session_id uuid,
  p_confirmation text,
  p_request_id uuid,
  p_capability_fingerprint text,
  p_subject_fingerprint text,
  p_scope_fingerprint text
)
returns table (
  request_id uuid,
  operation text,
  status text,
  receipt_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_row record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  select * into v_row from private.rv_core_service_execute_business_deletion(
    p_subject, p_session_id, p_confirmation, p_request_id,
    p_capability_fingerprint, p_subject_fingerprint, p_scope_fingerprint
  );
  -- The public Edge controller must first persist and prove the restore-v2 R2
  -- deletion event, then execute the rv2 deletion through the v2 intent RPC.
  -- This legacy operation only closes the reviewed v3 capability receipt; it
  -- must never be a second, journal-bypassing rv2 deletion path.
  return query select
    v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
end
$function$;

create or replace function public.rv_mark_destructive_operation_deleting(
  p_subject uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_capability_fingerprint text,
  p_subject_fingerprint text,
  p_scope_fingerprint text,
  p_operation text
)
returns table (
  request_id uuid,
  operation text,
  status text,
  receipt_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_row record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  select * into v_row from private.rv_core_mark_destructive_operation_deleting(
    p_subject, p_session_id, p_request_id, p_capability_fingerprint,
    p_subject_fingerprint, p_scope_fingerprint, p_operation
  );
  -- rv2 business data is already journaled and deleted by the v2 intent
  -- controller before this account state may advance to Auth deletion.
  return query select
    v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
end
$function$;

create function public.rv2_service_enqueue_due_syncs(
  p_worker_subject uuid,
  p_limit integer default 10
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_connection record;
  v_partition record;
  v_requested_by uuid;
  v_job_id uuid;
  v_idempotency_key uuid;
  v_request_fingerprint text;
  v_inserted integer := 0;
begin
  if p_worker_subject is null or p_limit not between 1 and 10 then
    raise exception 'scheduler request rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-scheduled-enqueue', 0
  ));

  for v_connection in
    select c.*
      from public.rv2_connections as c
      join public.rv2_tenants as t on t.tenant_id = c.tenant_id
     where c.status = 'ACTIVE'
       and c.permission_state = 'READ_ONLY_VERIFIED'
       and t.status = 'ACTIVE'
       and c.next_due_at <= statement_timestamp()
     order by c.next_due_at, c.connection_id
     limit p_limit
     for update of c skip locked
  loop
    v_requested_by := null;
    select m.user_id into v_requested_by
      from public.rv2_memberships as m
     where m.tenant_id = v_connection.tenant_id
       and m.status = 'ACTIVE'
       and m.member_role = 'OWNER'
     order by m.created_at, m.user_id
     limit 1;
    if v_requested_by is null then
      continue;
    end if;

    insert into private.rv2_sync_partitions (
      tenant_id, connection_id, dataset, partition_key
    )
    select v_connection.tenant_id, v_connection.connection_id, source.dataset, 'default'
      from unnest(array['income', 'force_orders', 'balances', 'positions'])
        as source(dataset)
    on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;

    insert into private.rv2_sync_partitions (
      tenant_id, connection_id, dataset, partition_key
    )
    select distinct
      v_connection.tenant_id,
      v_connection.connection_id,
      requested.dataset,
      upper(events.event_body ->> 'symbol')
      from public.rv2_source_events as events
      cross join unnest(array['fills', 'orders', 'algo_orders']) as requested(dataset)
     where events.tenant_id = v_connection.tenant_id
       and events.connection_id = v_connection.connection_id
       and events.dataset in ('fills', 'positions')
       and upper(events.event_body ->> 'symbol') ~ '^[A-Z0-9]{2,32}$'
    on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;

    for v_partition in
      select p.dataset, p.partition_key
        from private.rv2_sync_partitions as p
       where p.tenant_id = v_connection.tenant_id
         and p.connection_id = v_connection.connection_id
         and p.status = 'ACTIVE'
       order by p.dataset, p.partition_key
    loop
      if exists (
        select 1
          from private.rv2_sync_jobs as active_job
         where active_job.tenant_id = v_connection.tenant_id
           and active_job.connection_id = v_connection.connection_id
           and active_job.credential_version = v_connection.credential_version
           and active_job.dataset = v_partition.dataset
           and active_job.partition_key = v_partition.partition_key
           and active_job.status in ('QUEUED', 'CLAIMED')
      ) then
        continue;
      end if;
      v_job_id := gen_random_uuid();
      v_idempotency_key := gen_random_uuid();
      v_request_fingerprint := encode(extensions.digest(convert_to(
        'rv2-scheduled/1' || chr(0) || v_connection.tenant_id::text || chr(0)
        || v_connection.connection_id::text || chr(0)
        || v_connection.credential_version::text || chr(0)
        || v_partition.dataset || chr(0) || v_partition.partition_key,
        'utf8'
      ), 'sha256'), 'hex');
      insert into private.rv2_sync_jobs (
        tenant_id, job_id, connection_id, credential_version, requested_by,
        dataset, partition_key, queue_class, idempotency_key, request_fingerprint
      ) values (
        v_connection.tenant_id, v_job_id, v_connection.connection_id,
        v_connection.credential_version, v_requested_by, v_partition.dataset,
        v_partition.partition_key, 'SCHEDULED', v_idempotency_key,
        v_request_fingerprint
      );
      v_inserted := v_inserted + 1;
    end loop;

    update public.rv2_connections as c
       set next_due_at = statement_timestamp() + interval '1 hour',
           updated_at = statement_timestamp()
     where c.tenant_id = v_connection.tenant_id
       and c.connection_id = v_connection.connection_id
       and c.credential_version = v_connection.credential_version;
  end loop;
  return v_inserted;
end
$function$;

create function public.rv2_service_claim_sync_job(
  p_worker_subject uuid,
  p_job_id uuid default null,
  p_queue_class text default null,
  p_lease_seconds integer default 120
)
returns table (
  job_id uuid,
  tenant_id uuid,
  requested_by uuid,
  connection_id uuid,
  provider text,
  provider_scope_hash text,
  credential_version bigint,
  dataset text,
  partition_key text,
  page_cursor jsonb,
  page_number bigint,
  previous_page_digest text,
  queue_class text,
  attempt_id uuid,
  claim_token uuid,
  lease_expires_at timestamptz,
  envelope_ciphertext text,
  envelope_nonce text,
  envelope_key_ref text,
  envelope_sha256 text,
  permission_state text,
  permission_evidence jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_attempt_id uuid;
  v_claim_token uuid;
  v_lease_expires_at timestamptz;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null
     or p_lease_seconds not between 30 and 300
     or (p_queue_class is not null and p_queue_class not in ('INTERACTIVE', 'SCHEDULED')) then
    raise exception 'worker claim rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-global-worker-claim', 0
  ));
  perform 1
    from private.rv2_worker_control as control
   where control.singleton = true
     and control.circuit_open_until > statement_timestamp()
   for update;
  if found then
    return;
  end if;
  if exists (
    select 1
      from private.rv2_sync_jobs as running
     where running.status = 'CLAIMED'
       and running.lease_expires_at > statement_timestamp()
    union all
    select 1
      from private.rv2_archive_jobs as running
     where running.status = 'CLAIMED'
       and running.lease_expires_at > statement_timestamp()
  ) then
    return;
  end if;

  select j.*, c.provider, c.provider_scope_hash,
         c.permission_state, c.permission_evidence,
         e.envelope_ciphertext, e.envelope_nonce, e.envelope_key_ref, e.envelope_sha256
    into v_job
    from private.rv2_sync_jobs as j
    join public.rv2_connections as c
      on c.tenant_id = j.tenant_id and c.connection_id = j.connection_id
    join private.rv2_credential_envelopes as e
      on e.tenant_id = j.tenant_id
     and e.connection_id = j.connection_id
     and e.credential_version = j.credential_version
    join public.rv2_memberships as m
      on m.tenant_id = j.tenant_id and m.user_id = j.requested_by
    join public.rv2_tenants as t on t.tenant_id = j.tenant_id
   where (p_job_id is null or j.job_id = p_job_id)
     and (p_queue_class is null or j.queue_class = p_queue_class)
     and j.available_at <= statement_timestamp()
     and (
       j.status = 'QUEUED'
       or (j.status = 'CLAIMED' and j.lease_expires_at <= statement_timestamp())
     )
     and j.sync_complete = false
     and j.failure_count < 8
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
     and c.credential_version = j.credential_version
     and m.status = 'ACTIVE'
     and t.status = 'ACTIVE'
   order by j.available_at, j.job_id
   limit 1
   for update of j skip locked;
  if not found then
    return;
  end if;

  update private.rv2_sync_attempts as a
     set status = 'EXPIRED', completed_at = statement_timestamp()
   where a.tenant_id = v_job.tenant_id
     and a.job_id = v_job.job_id
     and a.status = 'CLAIMED';

  v_attempt_id := gen_random_uuid();
  v_claim_token := gen_random_uuid();
  v_lease_expires_at := statement_timestamp() + make_interval(secs => p_lease_seconds);
  update private.rv2_sync_jobs as j
     set status = 'CLAIMED',
         attempt_count = j.attempt_count + 1,
         worker_subject = p_worker_subject,
         claim_token = v_claim_token,
         lease_expires_at = v_lease_expires_at,
         last_error_code = null
   where j.job_id = v_job.job_id;
  insert into private.rv2_sync_attempts (
    tenant_id, job_id, attempt_id, attempt_no, worker_subject,
    claim_token, lease_expires_at
  ) values (
    v_job.tenant_id, v_job.job_id, v_attempt_id, v_job.attempt_count + 1,
    p_worker_subject, v_claim_token, v_lease_expires_at
  );

  return query select
    v_job.job_id,
    v_job.tenant_id,
    v_job.requested_by,
    v_job.connection_id,
    v_job.provider,
    v_job.provider_scope_hash,
    v_job.credential_version,
    v_job.dataset,
    v_job.partition_key,
    v_job.page_cursor,
    v_job.page_number,
    v_job.previous_page_digest,
    v_job.queue_class,
    v_attempt_id,
    v_claim_token,
    v_lease_expires_at,
    v_job.envelope_ciphertext,
    v_job.envelope_nonce,
    v_job.envelope_key_ref,
    v_job.envelope_sha256,
    v_job.permission_state,
    v_job.permission_evidence;
end
$function$;

create function public.rv2_service_renew_sync_job(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_lease_seconds integer default 120
)
returns table (
  job_id uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_lease_expires_at timestamptz;
begin
  if p_worker_subject is null or p_claim_token is null
     or p_lease_seconds not between 30 and 300 then
    raise exception 'worker lease rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_sync_jobs as j
   where j.job_id = p_job_id
     and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.status = 'CLAIMED'
     and j.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1
    from public.rv2_connections as c
    join public.rv2_memberships as m
      on m.tenant_id = c.tenant_id and m.user_id = v_job.requested_by
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version
     and c.status = 'ACTIVE'
     and m.status = 'ACTIVE';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  v_lease_expires_at := statement_timestamp() + make_interval(secs => p_lease_seconds);
  update private.rv2_sync_jobs as j
     set lease_expires_at = v_lease_expires_at
   where j.job_id = p_job_id;
  update private.rv2_sync_attempts as a
     set lease_expires_at = v_lease_expires_at
   where a.job_id = p_job_id
     and a.claim_token = p_claim_token
     and a.status = 'CLAIMED';
  return query select p_job_id, v_lease_expires_at;
end
$function$;

create function public.rv2_service_commit_sync_page(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_events jsonb,
  p_attempted_through timestamptz,
  p_fetched_through timestamptz,
  p_committed_through timestamptz,
  p_trusted_through timestamptz,
  p_coverage_state text,
  p_gaps jsonb default '[]'::jsonb,
  p_next_cursor jsonb default '{}'::jsonb,
  p_has_more boolean default false,
  p_page_digest text default null,
  p_post_commit_effect jsonb default
    '{"protocol":"rv-sync-post-commit/1","symbols":[],"ledgerShadow":null}'::jsonb
)
returns table (
  job_id uuid,
  status text,
  inserted_count integer,
  replayed_count integer,
  conflict_count integer,
  page_number bigint,
  page_cursor jsonb,
  sync_complete boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_event jsonb;
  v_gap jsonb;
  v_event_time timestamptz;
  v_key_count integer;
  v_inserted integer := 0;
  v_total integer;
  v_conflict_count integer := 0;
  v_partition_conflicted boolean := false;
  v_result_status text;
  v_attempt_id uuid;
  v_expected_symbols jsonb;
  v_effect_symbols jsonb;
  v_ledger_shadow jsonb;
  v_post_commit_input_digest text;
  v_effect_key_count integer;
  v_shadow_key_count integer;
  v_symbol jsonb;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 1000
     or jsonb_typeof(p_gaps) <> 'array'
     or jsonb_array_length(p_gaps) > 100
     or jsonb_typeof(p_next_cursor) <> 'object'
     or octet_length(p_next_cursor::text) > 4096
     or p_has_more is null
     or p_page_digest !~ '^[0-9a-f]{64}$'
     or p_post_commit_effect is null
     or p_trusted_through is not null
     or jsonb_typeof(p_post_commit_effect) <> 'object'
     or not (p_post_commit_effect ?& array['protocol', 'symbols', 'ledgerShadow'])
     or p_post_commit_effect ->> 'protocol' <> 'rv-sync-post-commit/1'
     or octet_length(p_post_commit_effect::text) > 1179648
     or p_coverage_state not in ('VERIFIED', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT')
     or (p_trusted_through is not null and (
       p_attempted_through is null or p_fetched_through is null
       or p_committed_through is null or p_trusted_through > p_committed_through
     ))
     or (p_committed_through is not null and (
       p_attempted_through is null or p_fetched_through is null
       or p_committed_through > p_fetched_through
     ))
     or (p_fetched_through is not null and (
       p_attempted_through is null or p_fetched_through > p_attempted_through
     ))
     or (p_coverage_state = 'VERIFIED' and (
       p_attempted_through is null or p_fetched_through is null
       or p_committed_through is null
       or jsonb_array_length(p_gaps) <> 0
     )) then
    raise exception 'sync page rejected' using errcode = '22023';
  end if;

  select j.* into v_job
    from private.rv2_sync_jobs as j
   where j.job_id = p_job_id
     and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.status = 'CLAIMED'
     and j.lease_expires_at > statement_timestamp()
     and j.sync_complete = false
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  select a.attempt_id into v_attempt_id
    from private.rv2_sync_attempts as a
   where a.tenant_id = v_job.tenant_id
     and a.job_id = v_job.job_id
     and a.worker_subject = p_worker_subject
     and a.claim_token = p_claim_token
     and a.status = 'CLAIMED'
     and a.lease_expires_at > statement_timestamp();
  if v_attempt_id is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if (p_has_more and p_next_cursor = v_job.page_cursor)
     or (v_job.previous_page_digest is not null
         and p_page_digest = v_job.previous_page_digest) then
    raise exception 'sync cursor did not advance' using errcode = '40001';
  end if;
  perform 1
    from public.rv2_connections as c
    join public.rv2_memberships as m
      on m.tenant_id = c.tenant_id and m.user_id = v_job.requested_by
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
     and m.status = 'ACTIVE';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  for v_event in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(v_event) <> 'object'
       or not (v_event ?& array['providerEventId', 'eventTime', 'payload']) then
      raise exception 'sync event rejected' using errcode = '22023';
    end if;
    select count(*) into v_key_count from jsonb_object_keys(v_event);
    if v_key_count <> 3
       or jsonb_typeof(v_event -> 'providerEventId') <> 'string'
       or length(v_event ->> 'providerEventId') not between 1 and 192
       or jsonb_typeof(v_event -> 'eventTime') <> 'string'
       or jsonb_typeof(v_event -> 'payload') <> 'object'
       or octet_length((v_event -> 'payload')::text) > 65536
       or (v_job.dataset = 'fills' and (
         not private.rv2_execution_row_is_valid(v_event -> 'payload')
         or v_event -> 'payload' ->> 'symbol' <> v_job.partition_key
         or (v_event ->> 'providerEventId') <> (
           'binance-usdm:fills:' || (v_event -> 'payload' ->> 'symbol') || ':'
             || (v_event -> 'payload' ->> 'id')
         )
       )) then
      raise exception 'sync event rejected' using errcode = '22023';
    end if;
    begin
      v_event_time := (v_event ->> 'eventTime')::timestamptz;
    exception when others then
      raise exception 'sync event rejected' using errcode = '22023';
    end;
  end loop;

  select count(*) into v_effect_key_count
    from jsonb_object_keys(p_post_commit_effect);
  v_effect_symbols := p_post_commit_effect -> 'symbols';
  v_ledger_shadow := p_post_commit_effect -> 'ledgerShadow';
  if v_effect_key_count <> 3
     or jsonb_typeof(v_effect_symbols) <> 'array'
     or jsonb_array_length(v_effect_symbols) > 256
     or (v_ledger_shadow <> 'null'::jsonb
       and jsonb_typeof(v_ledger_shadow) <> 'object') then
    raise exception 'post commit effect rejected' using errcode = '22023';
  end if;
  for v_symbol in select value from jsonb_array_elements(v_effect_symbols) loop
    if jsonb_typeof(v_symbol) <> 'string'
       or (v_symbol #>> '{}') !~ '^[A-Z0-9]{2,32}$' then
      raise exception 'post commit effect rejected' using errcode = '22023';
    end if;
  end loop;
  select coalesce(jsonb_agg(discovered.symbol order by discovered.symbol), '[]'::jsonb)
    into v_expected_symbols
    from (
      select distinct item -> 'payload' ->> 'symbol' as symbol
        from jsonb_array_elements(p_events) as item
       where jsonb_typeof(item -> 'payload' -> 'symbol') = 'string'
         and (item -> 'payload' ->> 'symbol') ~ '^[A-Z0-9]{2,32}$'
    ) as discovered;
  if v_effect_symbols <> v_expected_symbols then
    raise exception 'post commit symbols mismatch' using errcode = '22023';
  end if;
  if v_ledger_shadow <> 'null'::jsonb then
    select count(*) into v_shadow_key_count from jsonb_object_keys(v_ledger_shadow);
    if v_job.dataset not in ('fills', 'income')
       or v_shadow_key_count <> 3
       or not (v_ledger_shadow ?& array['projection', 'reconciliation', 'projectionDigest'])
       or jsonb_typeof(v_ledger_shadow -> 'projection') <> 'object'
       or octet_length((v_ledger_shadow -> 'projection')::text) > 1048576
       or v_ledger_shadow -> 'projection' ->> 'protocol' not in (
         'rv-ledger-projection/1', 'rv-ledger-shadow-page/1'
       )
       or (v_ledger_shadow ->> 'projectionDigest') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_ledger_shadow -> 'reconciliation') <> 'object'
       or octet_length((v_ledger_shadow -> 'reconciliation')::text) > 65536
       or v_ledger_shadow -> 'reconciliation' ->> 'protocol' <> 'rv-reconciliation/2'
       or v_ledger_shadow -> 'reconciliation' ->> 'stage' <> 'SHADOW'
       or v_ledger_shadow -> 'reconciliation' ->> 'status' <> 'NOT_EVALUATED'
       or v_ledger_shadow -> 'reconciliation' -> 'realGeneration' <> 'false'::jsonb
       or v_ledger_shadow -> 'reconciliation' -> 'generation' <> 'null'::jsonb
       or (v_ledger_shadow -> 'reconciliation' ->> 'projectionDigest')
          <> (v_ledger_shadow ->> 'projectionDigest')
       or (v_ledger_shadow -> 'reconciliation' ->> 'summaryDigest') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_ledger_shadow -> 'reconciliation' -> 'reasonCodes') <> 'array'
       or not (v_ledger_shadow -> 'reconciliation' -> 'reasonCodes' ? 'ORACLE_NOT_AVAILABLE')
       or not (v_ledger_shadow -> 'reconciliation' -> 'reasonCodes' ? 'PAGE_SCOPED_PROJECTION') then
      raise exception 'post commit ledger shadow rejected' using errcode = '22023';
    end if;
  end if;

  -- A source event provider identity conflict must survive the transaction.
  -- Raising here would roll back the evidence, so quarantine the whole page,
  -- persist the hash mismatch and return a fail-closed terminal result.
  with incoming as (
    select
      item ->> 'providerEventId' as provider_event_id,
      encode(extensions.digest(
        convert_to((item -> 'payload')::text, 'utf8'), 'sha256'
      ), 'hex') as event_sha256
      from jsonb_array_elements(p_events) as item
  ), combined as (
    select i.provider_event_id, i.event_sha256 from incoming as i
    union all
    select distinct i.provider_event_id, e.event_sha256
      from incoming as i
      join public.rv2_source_events as e
        on e.tenant_id = v_job.tenant_id
       and e.connection_id = v_job.connection_id
       and e.dataset = v_job.dataset
       and e.provider_event_id = i.provider_event_id
  ), conflicts as (
    select c.provider_event_id,
           min(c.event_sha256) as existing_sha256,
           max(c.event_sha256) as observed_sha256
      from combined as c
     group by c.provider_event_id
    having count(distinct c.event_sha256) > 1
  )
  insert into private.rv2_source_event_conflicts (
    tenant_id, connection_id, dataset, provider_event_id,
    existing_sha256, observed_sha256, first_job_id, last_job_id
  )
  select
    v_job.tenant_id, v_job.connection_id, v_job.dataset,
    conflict.provider_event_id, conflict.existing_sha256,
    conflict.observed_sha256, v_job.job_id, v_job.job_id
    from conflicts as conflict
  on conflict (tenant_id, connection_id, dataset, provider_event_id) do update
    set observed_sha256 = excluded.observed_sha256,
        last_job_id = excluded.last_job_id,
        status = 'OPEN',
        occurrences = private.rv2_source_event_conflicts.occurrences + 1,
        last_seen_at = statement_timestamp(),
        resolved_at = null;
  get diagnostics v_conflict_count = row_count;

  select exists (
    select 1
      from private.rv2_sync_coverage as c
     where c.tenant_id = v_job.tenant_id
       and c.connection_id = v_job.connection_id
       and c.dataset = v_job.dataset
       and c.partition_key = v_job.partition_key
       and c.state = 'CONFLICT'
  ) into v_partition_conflicted;

  if v_conflict_count > 0 or v_partition_conflicted then
    v_conflict_count := greatest(v_conflict_count, 1);
    insert into private.rv2_sync_coverage (
      tenant_id, connection_id, dataset, partition_key, state,
      attempted_through, fetched_through, committed_through, trusted_through,
      updated_by_job_id
    ) values (
      v_job.tenant_id, v_job.connection_id, v_job.dataset, v_job.partition_key,
      'CONFLICT', p_attempted_through, null, null, null, v_job.job_id
    )
    on conflict (tenant_id, connection_id, dataset, partition_key) do update
      set state = 'CONFLICT',
          attempted_through = greatest(
            private.rv2_sync_coverage.attempted_through,
            excluded.attempted_through
          ),
          updated_by_job_id = excluded.updated_by_job_id,
          updated_at = statement_timestamp();
    update private.rv2_sync_jobs as j
       set status = 'FAILED', sync_complete = false,
           completed_at = statement_timestamp(),
           last_error_code = 'SOURCE_IDENTITY_CONFLICT'
     where j.job_id = v_job.job_id;
    update private.rv2_sync_attempts as a
       set status = 'FAILED', error_code = 'SOURCE_IDENTITY_CONFLICT',
           completed_at = statement_timestamp()
     where a.job_id = v_job.job_id
       and a.claim_token = p_claim_token
       and a.status = 'CLAIMED';
    v_total := jsonb_array_length(p_events);
    return query select
      v_job.job_id, 'CONFLICT'::text, 0, 0, v_conflict_count,
      v_job.page_number, v_job.page_cursor, false;
    return;
  end if;

  insert into public.rv2_source_events (
    tenant_id, connection_id, sync_job_id, dataset, provider_event_id,
    event_time, event_body, event_sha256
  )
  select
    v_job.tenant_id,
    v_job.connection_id,
    v_job.job_id,
    v_job.dataset,
    item ->> 'providerEventId',
    (item ->> 'eventTime')::timestamptz,
    item -> 'payload',
    encode(extensions.digest(
      convert_to((item -> 'payload')::text, 'utf8'), 'sha256'
    ), 'hex')
  from jsonb_array_elements(p_events) as item
  on conflict (tenant_id, connection_id, dataset, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  v_total := jsonb_array_length(p_events);

  insert into private.rv2_sync_coverage (
    tenant_id, connection_id, dataset, partition_key, state,
    attempted_through, fetched_through, committed_through, trusted_through,
    updated_by_job_id
  ) values (
    v_job.tenant_id, v_job.connection_id, v_job.dataset, v_job.partition_key,
    p_coverage_state, p_attempted_through, p_fetched_through,
    p_committed_through, p_trusted_through, v_job.job_id
  )
  on conflict (tenant_id, connection_id, dataset, partition_key) do update
    set state = case
          when private.rv2_sync_coverage.state = 'CONFLICT' then 'CONFLICT'
          else excluded.state
        end,
        attempted_through = greatest(private.rv2_sync_coverage.attempted_through, excluded.attempted_through),
        fetched_through = greatest(private.rv2_sync_coverage.fetched_through, excluded.fetched_through),
        committed_through = greatest(private.rv2_sync_coverage.committed_through, excluded.committed_through),
        trusted_through = greatest(private.rv2_sync_coverage.trusted_through, excluded.trusted_through),
        updated_by_job_id = excluded.updated_by_job_id,
        updated_at = statement_timestamp();

  for v_gap in select value from jsonb_array_elements(p_gaps) loop
    if jsonb_typeof(v_gap) <> 'object'
       or not (v_gap ?& array['code', 'from', 'to']) then
      raise exception 'sync gap rejected' using errcode = '22023';
    end if;
    select count(*) into v_key_count from jsonb_object_keys(v_gap);
    if v_key_count <> 3
       or (v_gap ->> 'code') !~ '^[A-Z][A-Z0-9_]{0,63}$' then
      raise exception 'sync gap rejected' using errcode = '22023';
    end if;
    begin
      if (v_gap ->> 'from')::timestamptz >= (v_gap ->> 'to')::timestamptz then
        raise exception 'sync gap rejected' using errcode = '22023';
      end if;
    exception when invalid_datetime_format then
      raise exception 'sync gap rejected' using errcode = '22023';
    end;
    insert into private.rv2_sync_gaps (
      tenant_id, connection_id, dataset, partition_key, gap_code,
      gap_start, gap_end, detected_by_job_id
    ) values (
      v_job.tenant_id, v_job.connection_id, v_job.dataset, v_job.partition_key,
      v_gap ->> 'code', (v_gap ->> 'from')::timestamptz,
      (v_gap ->> 'to')::timestamptz, v_job.job_id
    );
    if v_job.dataset in ('fills', 'orders', 'income')
       and v_gap ->> 'code' in ('HISTORY_NOT_YET_PROVEN', 'RETENTION_WINDOW_GAP') then
      insert into private.rv2_archive_jobs (
        tenant_id, job_id, connection_id, credential_version, dataset,
        window_start, window_end
      ) values (
        v_job.tenant_id, v_job.job_id, v_job.connection_id,
        v_job.credential_version, v_job.dataset,
        floor(extract(epoch from (v_gap ->> 'from')::timestamptz) * 1000)::bigint::text,
        least(
          floor(extract(epoch from (v_gap ->> 'to')::timestamptz) * 1000)::bigint,
          floor(extract(epoch from (v_gap ->> 'from')::timestamptz) * 1000)::bigint
            + 2678400000
        )::text
      )
      on conflict (job_id) do nothing;
    end if;
  end loop;

  v_post_commit_input_digest := encode(extensions.digest(convert_to(jsonb_build_object(
    'protocol', 'rv-sync-post-commit-work/1',
    'jobId', v_job.job_id,
    'attemptId', v_attempt_id,
    'pageNumber', v_job.page_number + 1,
    'effect', p_post_commit_effect
  )::text, 'utf8'), 'sha256'), 'hex');
  insert into private.rv2_post_commit_work (
    tenant_id, job_id, connection_id, credential_version, attempt_id,
    page_number, source_worker_subject, source_claim_token, work_kind,
    effect, input_digest
  ) values (
    v_job.tenant_id, v_job.job_id, v_job.connection_id, p_credential_version,
    v_attempt_id, v_job.page_number + 1, p_worker_subject, p_claim_token,
    'SYNC_EFFECTS', p_post_commit_effect, v_post_commit_input_digest
  );

  v_result_status := case when p_has_more then 'QUEUED' else 'SUCCEEDED' end;
  update private.rv2_sync_jobs as j
     set status = case when p_has_more then 'QUEUED' else 'SUCCEEDED' end,
         page_committed = true,
         page_cursor = p_next_cursor,
         page_number = j.page_number + 1,
         previous_page_digest = p_page_digest,
         sync_complete = not p_has_more,
         worker_subject = case when p_has_more then null else j.worker_subject end,
         claim_token = case when p_has_more then null else j.claim_token end,
         lease_expires_at = null,
         available_at = case when p_has_more then statement_timestamp() else j.available_at end,
         completed_at = case when p_has_more then null else statement_timestamp() end,
         last_error_code = null
   where j.job_id = v_job.job_id;
  update private.rv2_sync_attempts as a
     set status = 'COMMITTED', completed_at = statement_timestamp()
   where a.job_id = v_job.job_id
     and a.claim_token = p_claim_token
     and a.status = 'CLAIMED';
  update public.rv2_connections as c
     set status = 'ACTIVE',
         next_due_at = case when p_has_more
           then c.next_due_at else statement_timestamp() + interval '1 hour' end,
         last_error_code = null,
         updated_at = statement_timestamp()
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version;

  return query select
    v_job.job_id, v_result_status, v_inserted, v_total - v_inserted, 0,
    v_job.page_number + 1, p_next_cursor, not p_has_more;
end
$function$;

create function public.rv2_service_schedule_discovered_symbols(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_symbols jsonb
)
returns table (scheduled_count integer)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_symbol jsonb;
  v_symbol_text text;
  v_inserted integer := 0;
  v_rows integer;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or jsonb_typeof(p_symbols) <> 'array'
     or jsonb_array_length(p_symbols) not between 1 and 256 then
    raise exception 'symbol discovery rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_sync_jobs as j
    join private.rv2_sync_attempts as a
      on a.tenant_id = j.tenant_id
     and a.job_id = j.job_id
     and a.attempt_no = j.attempt_count
   where j.job_id = p_job_id
     and j.credential_version = p_credential_version
     and j.page_number > 0
     and a.worker_subject = p_worker_subject
     and a.claim_token = p_claim_token
     and a.status = 'COMMITTED'
   for update of j;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1 from public.rv2_connections as c
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version
     and c.status = 'ACTIVE';
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  for v_symbol in select value from jsonb_array_elements(p_symbols) loop
    if jsonb_typeof(v_symbol) <> 'string' then
      raise exception 'symbol discovery rejected' using errcode = '22023';
    end if;
    v_symbol_text := v_symbol #>> '{}';
    if v_symbol_text !~ '^[A-Z0-9]{2,32}$' then
      raise exception 'symbol discovery rejected' using errcode = '22023';
    end if;
    insert into private.rv2_sync_partitions (
      tenant_id, connection_id, dataset, partition_key
    )
    select v_job.tenant_id, v_job.connection_id, requested.dataset, v_symbol_text
      from unnest(array['fills', 'orders', 'algo_orders']) as requested(dataset)
    on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;
  return query select v_inserted;
end
$function$;

create function public.rv2_service_submit_ledger_shadow(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_projection jsonb,
  p_reconciliation jsonb,
  p_projection_digest text
)
returns table (
  job_id uuid,
  page_number bigint,
  status text,
  projection_sha256 text,
  reconciliation jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_existing record;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or jsonb_typeof(p_projection) <> 'object'
     or octet_length(p_projection::text) > 1048576
     or p_projection ->> 'protocol' not in (
       'rv-ledger-projection/1', 'rv-ledger-shadow-page/1'
     )
     or p_projection_digest !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_reconciliation) <> 'object'
     or octet_length(p_reconciliation::text) > 65536
     or p_reconciliation ->> 'protocol' <> 'rv-reconciliation/2'
     or p_reconciliation ->> 'stage' <> 'SHADOW'
     or p_reconciliation ->> 'status' <> 'NOT_EVALUATED'
     or p_reconciliation -> 'realGeneration' <> 'false'::jsonb
     or p_reconciliation -> 'generation' <> 'null'::jsonb
     or p_reconciliation ->> 'projectionDigest' <> p_projection_digest
     or (p_reconciliation ->> 'summaryDigest') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_reconciliation -> 'reasonCodes') <> 'array'
     or not (p_reconciliation -> 'reasonCodes' ? 'ORACLE_NOT_AVAILABLE')
     or not (p_reconciliation -> 'reasonCodes' ? 'PAGE_SCOPED_PROJECTION') then
    raise exception 'ledger shadow rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_sync_jobs as j
    join private.rv2_sync_attempts as a
      on a.tenant_id = j.tenant_id
     and a.job_id = j.job_id
     and a.attempt_no = j.attempt_count
   where j.job_id = p_job_id
     and j.credential_version = p_credential_version
     and j.dataset in ('fills', 'income')
     and j.page_number > 0
     and a.worker_subject = p_worker_subject
     and a.claim_token = p_claim_token
     and a.status = 'COMMITTED'
   for update of j;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  select s.* into v_existing
    from private.rv2_ledger_shadow_submissions as s
   where s.tenant_id = v_job.tenant_id
     and s.job_id = v_job.job_id
     and s.page_number = v_job.page_number;
  if found then
    if v_existing.projection_sha256 <> p_projection_digest
       or v_existing.source_claim_token <> p_claim_token then
      raise exception 'ledger shadow replay conflict' using errcode = '40001';
    end if;
    return query select
      v_existing.job_id, v_existing.page_number, v_existing.status,
      v_existing.projection_sha256, v_existing.reconciliation;
    return;
  end if;

  insert into private.rv2_ledger_shadow_submissions (
    tenant_id, connection_id, job_id, page_number, credential_version,
    source_claim_token, projection, projection_sha256, reconciliation, status
  ) values (
    v_job.tenant_id, v_job.connection_id, v_job.job_id, v_job.page_number,
    p_credential_version, p_claim_token, p_projection, p_projection_digest,
    p_reconciliation, 'SHADOW_ONLY'
  );
  return query select
    v_job.job_id, v_job.page_number, 'SHADOW_ONLY'::text,
    p_projection_digest, p_reconciliation;
end
$function$;

create function public.rv2_service_claim_post_commit_work(
  p_worker_subject uuid,
  p_job_id uuid default null,
  p_lease_seconds integer default 120
)
returns table (
  work_id uuid,
  job_id uuid,
  connection_id uuid,
  credential_version bigint,
  attempt_id uuid,
  lease_token uuid,
  work_kind text,
  input_digest text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_work record;
  v_job record;
  v_lease_token uuid;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_lease_seconds not between 30 and 300 then
    raise exception 'post commit claim rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-global-post-commit-claim', 0
  ));
  if exists (
    select 1
      from private.rv2_post_commit_work as running
     where running.status = 'CLAIMED'
       and running.lease_expires_at > statement_timestamp()
  ) then
    return;
  end if;
  select w.* into v_work
    from private.rv2_post_commit_work as w
    join public.rv2_connections as c
      on c.tenant_id = w.tenant_id and c.connection_id = w.connection_id
    join public.rv2_tenants as t on t.tenant_id = w.tenant_id
   where (p_job_id is null or w.job_id = p_job_id)
     and w.available_at <= statement_timestamp()
     and (
       w.status = 'PENDING'
       or (w.status = 'CLAIMED' and w.lease_expires_at <= statement_timestamp())
     )
     and w.failure_count < 8
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
     and c.credential_version = w.credential_version
     and t.status = 'ACTIVE'
     and not exists (
       select 1 from private.rv2_post_commit_work as connection_running
        where connection_running.connection_id = w.connection_id
          and connection_running.status = 'CLAIMED'
          and connection_running.lease_expires_at > statement_timestamp()
     )
   order by w.available_at, w.work_id
   limit 1
   for update of w skip locked;
  if not found then
    return;
  end if;
  v_lease_token := gen_random_uuid();
  update private.rv2_post_commit_work as w
     set status = 'CLAIMED', worker_subject = p_worker_subject,
         lease_token = v_lease_token,
         lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
         last_error_code = null
   where w.work_id = v_work.work_id;
  return query select
    v_work.work_id, v_work.job_id, v_work.connection_id,
    v_work.credential_version, v_work.attempt_id, v_lease_token,
    v_work.work_kind, v_work.input_digest;
end
$function$;

create function public.rv2_service_complete_post_commit_work(
  p_worker_subject uuid,
  p_work_id uuid,
  p_job_id uuid,
  p_credential_version bigint,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_input_digest text
)
returns table (accepted boolean, replayed boolean, status text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_work record;
  v_job record;
  v_symbol jsonb;
  v_symbol_text text;
  v_shadow jsonb;
  v_existing_shadow record;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_work_id is null or p_job_id is null
     or coalesce(p_credential_version, 0) <= 0 or p_attempt_id is null
     or p_lease_token is null or p_input_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'post commit completion rejected' using errcode = '22023';
  end if;
  select w.* into v_work
    from private.rv2_post_commit_work as w
   where w.work_id = p_work_id
     and w.job_id = p_job_id
     and w.credential_version = p_credential_version
     and w.attempt_id = p_attempt_id
     and w.input_digest = p_input_digest
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_work.status = 'DONE' then
    if v_work.worker_subject <> p_worker_subject
       or v_work.lease_token <> p_lease_token then
      raise exception 'resource not found' using errcode = 'P0002';
    end if;
    return query select true, true, 'DONE'::text;
    return;
  end if;
  if v_work.status <> 'CLAIMED'
     or v_work.worker_subject <> p_worker_subject
     or v_work.lease_token <> p_lease_token
     or v_work.lease_expires_at <= statement_timestamp() then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1
    from private.rv2_sync_attempts as a
    join private.rv2_sync_jobs as j
      on j.tenant_id = a.tenant_id and j.job_id = a.job_id
    join public.rv2_connections as c
      on c.tenant_id = j.tenant_id and c.connection_id = j.connection_id
   where a.attempt_id = v_work.attempt_id
     and a.job_id = v_work.job_id
     and a.worker_subject = v_work.source_worker_subject
     and a.claim_token = v_work.source_claim_token
     and a.status = 'COMMITTED'
     and j.connection_id = v_work.connection_id
     and j.credential_version = v_work.credential_version
     and j.page_number >= v_work.page_number
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
     and c.credential_version = v_work.credential_version;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  for v_symbol in select value from jsonb_array_elements(v_work.effect -> 'symbols') loop
    v_symbol_text := v_symbol #>> '{}';
    insert into private.rv2_sync_partitions (
      tenant_id, connection_id, dataset, partition_key
    )
    select v_work.tenant_id, v_work.connection_id, requested.dataset, v_symbol_text
      from unnest(array['fills', 'orders', 'algo_orders']) as requested(dataset)
    on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;
  end loop;

  v_shadow := v_work.effect -> 'ledgerShadow';
  if v_shadow <> 'null'::jsonb then
    select s.* into v_existing_shadow
      from private.rv2_ledger_shadow_submissions as s
     where s.tenant_id = v_work.tenant_id
       and s.job_id = v_work.job_id
       and s.page_number = v_work.page_number;
    if found then
      if v_existing_shadow.projection_sha256 <> v_shadow ->> 'projectionDigest'
         or v_existing_shadow.source_claim_token <> v_work.source_claim_token then
        raise exception 'ledger shadow replay conflict' using errcode = '40001';
      end if;
    else
      insert into private.rv2_ledger_shadow_submissions (
        tenant_id, connection_id, job_id, page_number, credential_version,
        source_claim_token, projection, projection_sha256, reconciliation, status
      ) values (
        v_work.tenant_id, v_work.connection_id, v_work.job_id,
        v_work.page_number, v_work.credential_version, v_work.source_claim_token,
        v_shadow -> 'projection', v_shadow ->> 'projectionDigest',
        v_shadow -> 'reconciliation', 'SHADOW_ONLY'
      );
    end if;
  end if;

  update private.rv2_post_commit_work as w
     set status = 'DONE', lease_expires_at = null,
         last_error_code = null, completed_at = statement_timestamp()
   where w.work_id = v_work.work_id;

  select j.* into v_job
    from private.rv2_sync_jobs as j
   where j.tenant_id = v_work.tenant_id
     and j.job_id = v_work.job_id
     and j.connection_id = v_work.connection_id
     and j.credential_version = v_work.credential_version;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  -- The immutable event page becomes trusted only after its durable
  -- post-commit effect is complete. Coverage may remain PARTIAL because a
  -- trusted prefix is not proof that the historical interval is complete.
  update private.rv2_sync_coverage as c
     set trusted_through = greatest(c.trusted_through, c.committed_through),
         updated_by_job_id = v_job.job_id,
         updated_at = statement_timestamp()
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.dataset = v_job.dataset
     and c.partition_key = v_job.partition_key
     and c.state <> 'CONFLICT'
     and c.committed_through is not null;
  update public.rv2_connections as c
     set last_trusted_at = greatest(c.last_trusted_at, coverage.trusted_through),
         updated_at = statement_timestamp()
    from private.rv2_sync_coverage as coverage
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = v_job.credential_version
     and coverage.tenant_id = c.tenant_id
     and coverage.connection_id = c.connection_id
     and coverage.dataset = v_job.dataset
     and coverage.partition_key = v_job.partition_key
     and coverage.trusted_through is not null;

  -- Publishing is a same-transaction, best-effort coordinator. It returns no
  -- row while any connection work/conflict remains, so completing one page
  -- cannot expose a partial source frontier chosen by the Edge caller.
  perform * from public.rv2_service_publish_generation(
    p_worker_subject,
    v_job.connection_id,
    (select c.current_generation from public.rv2_connections as c
      where c.tenant_id = v_job.tenant_id and c.connection_id = v_job.connection_id),
    v_job.credential_version,
    array[v_job.job_id]
  );
  return query select true, false, 'DONE'::text;
end
$function$;

create function public.rv2_service_fail_post_commit_work(
  p_worker_subject uuid,
  p_work_id uuid,
  p_job_id uuid,
  p_credential_version bigint,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_input_digest text,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 0
)
returns table (accepted boolean, replayed boolean, status text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_work record;
  v_status text;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_work_id is null or p_job_id is null
     or coalesce(p_credential_version, 0) <= 0 or p_attempt_id is null
     or p_lease_token is null or p_input_digest !~ '^[0-9a-f]{64}$'
     or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null
     or p_retry_after_seconds not between 0 and 86400 then
    raise exception 'post commit failure rejected' using errcode = '22023';
  end if;
  select w.* into v_work
    from private.rv2_post_commit_work as w
   where w.work_id = p_work_id
     and w.job_id = p_job_id
     and w.credential_version = p_credential_version
     and w.attempt_id = p_attempt_id
     and w.worker_subject = p_worker_subject
     and w.lease_token = p_lease_token
     and w.input_digest = p_input_digest
     and w.status = 'CLAIMED'
     and w.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_status := case when p_retryable and v_work.failure_count < 7
    then 'PENDING' else 'FAILED' end;
  update private.rv2_post_commit_work as w
     set status = v_status,
         failure_count = w.failure_count + 1,
         worker_subject = null,
         lease_token = null,
         lease_expires_at = null,
         available_at = case when v_status = 'PENDING'
           then statement_timestamp() + make_interval(
             secs => greatest(p_retry_after_seconds, 1)
           ) else w.available_at end,
         last_error_code = p_error_code,
         completed_at = case when v_status = 'FAILED'
           then statement_timestamp() else null end
   where w.work_id = v_work.work_id;
  return query select true, false, v_status;
end
$function$;

create function public.rv2_service_open_worker_circuit(
  p_worker_subject uuid,
  p_error_code text,
  p_retry_after_seconds integer default 300
)
returns table (circuit_open_until timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_open_until timestamptz;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null
     or p_error_code <> 'GLOBAL_CIRCUIT_OPEN'
     or p_retry_after_seconds not between 1 and 3600 then
    raise exception 'worker circuit rejected' using errcode = '22023';
  end if;
  update private.rv2_worker_control as control
     set circuit_open_until = greatest(
           coalesce(control.circuit_open_until, statement_timestamp()),
           statement_timestamp() + make_interval(secs => greatest(p_retry_after_seconds, 300))
         ),
         last_error_code = p_error_code,
         updated_at = statement_timestamp()
   where control.singleton = true
   returning control.circuit_open_until into v_open_until;
  if not found then
    raise exception 'worker circuit unavailable' using errcode = '55000';
  end if;
  return query select v_open_until;
end
$function$;

create function public.rv2_service_fail_sync_job(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 0
)
returns table (
  job_id uuid,
  status text,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_status text;
  v_available_at timestamptz;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_retry_after_seconds not between 0 and 86400 then
    raise exception 'sync failure rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_sync_jobs as j
   where j.job_id = p_job_id
     and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.status = 'CLAIMED'
     and j.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1 from public.rv2_connections as c
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  if p_retryable and v_job.failure_count < 7 then
    v_status := 'QUEUED';
    v_available_at := statement_timestamp() + make_interval(secs => p_retry_after_seconds);
  else
    v_status := 'FAILED';
    v_available_at := statement_timestamp();
  end if;
  if p_error_code = 'GLOBAL_CIRCUIT_OPEN' then
    update private.rv2_worker_control as control
       set circuit_open_until = greatest(
             coalesce(control.circuit_open_until, statement_timestamp()),
             statement_timestamp() + make_interval(secs => greatest(p_retry_after_seconds, 300))
           ),
           last_error_code = p_error_code,
           updated_at = statement_timestamp()
     where control.singleton = true;
  end if;
  update private.rv2_sync_jobs as j
     set status = v_status,
         failure_count = j.failure_count + 1,
         available_at = v_available_at,
         last_error_code = p_error_code,
         worker_subject = case when v_status = 'QUEUED' then null else j.worker_subject end,
         claim_token = case when v_status = 'QUEUED' then null else j.claim_token end,
         lease_expires_at = case when v_status = 'QUEUED' then null else j.lease_expires_at end,
         completed_at = case when v_status = 'FAILED' then statement_timestamp() else null end
   where j.job_id = v_job.job_id;
  update private.rv2_sync_attempts as a
     set status = 'FAILED', error_code = p_error_code,
         completed_at = statement_timestamp()
   where a.job_id = v_job.job_id
     and a.claim_token = p_claim_token
     and a.status = 'CLAIMED';
  update public.rv2_connections as c
     set status = case
           when p_error_code = 'AUTH_DISABLED' then 'AUTH_ERROR'
           when p_error_code in ('RATE_LIMITED', 'GLOBAL_CIRCUIT_OPEN') then 'RATE_LIMITED'
           else c.status
         end,
         last_error_code = p_error_code,
         next_due_at = v_available_at,
         updated_at = statement_timestamp()
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id;
  return query select v_job.job_id, v_status, v_available_at;
end
$function$;

create function public.rv2_service_claim_archive_job(
  p_worker_subject uuid,
  p_job_id uuid default null,
  p_lease_seconds integer default 120
)
returns table (
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  credential_version bigint,
  claim_token uuid,
  envelope_ciphertext text,
  envelope_nonce text,
  envelope_key_ref text,
  envelope_sha256 text,
  dataset text,
  window_start text,
  window_end text,
  state jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_claim_token uuid;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_lease_seconds not between 30 and 300 then
    raise exception 'archive claim rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-global-worker-claim', 0
  ));
  perform 1
    from private.rv2_worker_control as control
   where control.singleton = true
     and control.circuit_open_until > statement_timestamp()
   for update;
  if found then
    return;
  end if;
  if exists (
    select 1 from private.rv2_sync_jobs as running
     where running.status = 'CLAIMED'
       and running.lease_expires_at > statement_timestamp()
    union all
    select 1 from private.rv2_archive_jobs as running
     where running.status = 'CLAIMED'
       and running.lease_expires_at > statement_timestamp()
  ) then
    return;
  end if;
  select j.*, e.envelope_ciphertext, e.envelope_nonce,
         e.envelope_key_ref, e.envelope_sha256
    into v_job
    from private.rv2_archive_jobs as j
    join public.rv2_connections as c
      on c.tenant_id = j.tenant_id and c.connection_id = j.connection_id
    join public.rv2_tenants as t on t.tenant_id = j.tenant_id
    join private.rv2_credential_envelopes as e
      on e.tenant_id = j.tenant_id
     and e.connection_id = j.connection_id
     and e.credential_version = j.credential_version
   where (p_job_id is null or j.job_id = p_job_id)
     and j.available_at <= statement_timestamp()
     and (
       j.status in ('QUEUED', 'REQUEST_PENDING', 'POLL_PENDING')
       or (j.status = 'CLAIMED' and j.lease_expires_at <= statement_timestamp())
     )
     and j.failure_count < 8
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
     and c.credential_version = j.credential_version
     and e.result_status = 'ACTIVE'
     and e.retired_at is null
     and t.status = 'ACTIVE'
   order by j.available_at, j.job_id
   limit 1
   for update of j skip locked;
  if not found then
    return;
  end if;
  v_claim_token := gen_random_uuid();
  update private.rv2_archive_jobs as j
     set status = 'CLAIMED', worker_subject = p_worker_subject,
         claim_token = v_claim_token,
         lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
         last_error_code = null, updated_at = statement_timestamp()
   where j.job_id = v_job.job_id;
  return query select
    v_job.job_id, v_job.tenant_id, v_job.connection_id,
    v_job.credential_version, v_claim_token,
    v_job.envelope_ciphertext, v_job.envelope_nonce,
    v_job.envelope_key_ref, v_job.envelope_sha256,
    v_job.dataset, v_job.window_start, v_job.window_end, v_job.archive_state;
end
$function$;

create function public.rv2_service_commit_archive_state(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_state jsonb
)
returns table (job_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_status text;
  v_key_count integer;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or jsonb_typeof(p_state) <> 'object'
     or octet_length(p_state::text) > 16384
     or p_state ->> 'protocol' <> 'rv-binance-archive/1'
     or p_state ->> 'status' not in (
       'REQUEST_PENDING', 'POLL_PENDING', 'CSV_REQUIRED', 'STAGED'
     ) then
    raise exception 'archive state rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_archive_jobs as j
   where j.job_id = p_job_id
     and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.status = 'CLAIMED'
     and j.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_status := p_state ->> 'status';
  select count(*) into v_key_count from jsonb_object_keys(p_state);
  if p_state ->> 'dataset' <> v_job.dataset
     or p_state ->> 'startTime' <> v_job.window_start
     or p_state ->> 'endTime' <> v_job.window_end
     or (p_state ->> 'pollCount') !~ '^[0-9]{1,3}$'
     or (p_state ->> 'pollCount')::integer > 120
     or (v_status = 'REQUEST_PENDING' and v_key_count <> 9)
     or (v_status in ('POLL_PENDING', 'CSV_REQUIRED', 'STAGED') and v_key_count <> 10)
     or (v_status = 'POLL_PENDING' and (p_state ->> 'downloadId') !~ '^[A-Za-z0-9._:-]{8,256}$')
     or (v_status = 'CSV_REQUIRED' and p_state ->> 'fallbackReason' not in (
       'QUOTA_EXHAUSTED', 'COVERAGE_UNAVAILABLE', 'POLL_EXHAUSTED', 'LINK_EXPIRED'
     ))
     or (v_status = 'STAGED' and not exists (
       select 1 from private.rv2_archives as a
        where a.archive_id = (p_state ->> 'archiveId')::uuid
          and a.tenant_id = v_job.tenant_id
          and a.connection_id = v_job.connection_id
          and a.dataset = v_job.dataset
     )) then
    raise exception 'archive state rejected' using errcode = '22023';
  end if;
  update private.rv2_archive_jobs as j
     set archive_state = p_state, status = v_status,
         worker_subject = null, claim_token = null, lease_expires_at = null,
         available_at = case
           when v_status in ('REQUEST_PENDING', 'POLL_PENDING')
             then statement_timestamp() + interval '30 seconds'
           else j.available_at
         end,
         completed_at = case when v_status in ('CSV_REQUIRED', 'STAGED')
           then statement_timestamp() else null end,
         updated_at = statement_timestamp(), last_error_code = null
   where j.job_id = v_job.job_id;
  return query select v_job.job_id, v_status;
exception when invalid_text_representation then
  raise exception 'archive state rejected' using errcode = '22023';
end
$function$;

create function public.rv2_service_fail_archive_job(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 0
)
returns table (job_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_status text;
  v_available_at timestamptz;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null or p_retryable is null
     or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_retry_after_seconds not between 0 and 86400 then
    raise exception 'archive failure rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_archive_jobs as j
   where j.job_id = p_job_id and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.status = 'CLAIMED'
     and j.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_status := case when p_retryable and v_job.failure_count < 7
    then 'QUEUED' else 'FAILED' end;
  v_available_at := case
    when v_status <> 'QUEUED' then statement_timestamp()
    when p_error_code in ('RATE_LIMITED', 'GLOBAL_CIRCUIT_OPEN') then
      statement_timestamp() + make_interval(secs => p_retry_after_seconds)
    else statement_timestamp() + make_interval(secs => greatest(p_retry_after_seconds, 30))
  end;
  if p_error_code = 'GLOBAL_CIRCUIT_OPEN' then
    perform public.rv2_service_open_worker_circuit(
      p_worker_subject, p_error_code, greatest(p_retry_after_seconds, 1)
    );
  end if;
  update private.rv2_archive_jobs as j
     set status = v_status, failure_count = j.failure_count + 1,
         worker_subject = null, claim_token = null, lease_expires_at = null,
         available_at = case when v_status = 'QUEUED' then v_available_at else j.available_at end,
         last_error_code = p_error_code,
         completed_at = case when v_status = 'FAILED' then statement_timestamp() else null end,
         updated_at = statement_timestamp()
   where j.job_id = v_job.job_id;
  update public.rv2_connections as c
     set status = case
           when p_error_code = 'AUTH_DISABLED' then 'AUTH_ERROR'
           when p_error_code in ('RATE_LIMITED', 'GLOBAL_CIRCUIT_OPEN') then 'RATE_LIMITED'
           else c.status
         end,
         last_error_code = p_error_code,
         next_due_at = v_available_at,
         updated_at = statement_timestamp()
   where c.tenant_id = v_job.tenant_id
     and c.connection_id = v_job.connection_id
     and c.credential_version = p_credential_version;
  return query select v_job.job_id, v_status;
end
$function$;

create function public.rv2_service_stage_archive_link(
  p_worker_subject uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_credential_version bigint,
  p_dataset text,
  p_window_start text,
  p_window_end text,
  p_download_id text,
  p_download_url text,
  p_expires_at timestamptz
)
returns table (archive_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_job record;
  v_archive_id uuid;
  v_object_ref_hash text;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null or p_claim_token is null
     or p_dataset not in ('fills', 'orders', 'income')
     or p_window_start !~ '^[0-9]{1,128}$' or p_window_end !~ '^[0-9]{1,128}$'
     or p_download_id !~ '^[A-Za-z0-9._:-]{8,256}$'
     or length(p_download_url) not between 16 and 4096
     or p_download_url !~ '^https://[^/?#[:space:]]+(/[^[:space:]#]*)?(\?[^[:space:]#]*)?$'
     or p_download_url ~ '@'
     or p_expires_at <= statement_timestamp()
     or p_expires_at > statement_timestamp() + interval '7 days' then
    raise exception 'archive link rejected' using errcode = '22023';
  end if;
  select j.* into v_job
    from private.rv2_archive_jobs as j
   where j.job_id = p_job_id and j.worker_subject = p_worker_subject
     and j.claim_token = p_claim_token
     and j.credential_version = p_credential_version
     and j.dataset = p_dataset
     and j.window_start = p_window_start and j.window_end = p_window_end
     and j.status = 'CLAIMED' and j.lease_expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_job.archive_state ->> 'status' <> 'POLL_PENDING'
     or v_job.archive_state ->> 'downloadId' <> p_download_id then
    raise exception 'archive link rejected' using errcode = '40001';
  end if;
  v_object_ref_hash := encode(extensions.digest(convert_to(
    p_download_id || chr(0) || p_download_url, 'utf8'
  ), 'sha256'), 'hex');
  select a.archive_id into v_archive_id
    from private.rv2_archives as a
   where a.tenant_id = v_job.tenant_id
     and a.job_id = v_job.job_id
     and a.connection_id = v_job.connection_id
     and a.dataset = p_dataset
     and a.partition_key = v_job.window_start || ':' || v_job.window_end
     and a.object_ref_hash = v_object_ref_hash;
  if not found then
    v_archive_id := gen_random_uuid();
    insert into private.rv2_archives (
      tenant_id, archive_id, job_id, connection_id, dataset, partition_key,
      object_ref_hash, archive_sha256, bytes, download_url, expires_at,
      status, completed_at
    ) values (
      v_job.tenant_id, v_archive_id, v_job.job_id, v_job.connection_id, p_dataset,
      v_job.window_start || ':' || v_job.window_end, v_object_ref_hash,
      null, null, p_download_url, p_expires_at, 'PENDING', null
    );
  end if;
  -- STAGED here means the short link is in a private table.  It deliberately
  -- remains PENDING until the exact private Actions run/attempt consumes the
  -- URL once and attests the observed file byte count and SHA-256.  This is a
  -- trusted-workflow observation, not a Binance-signed content digest; URL
  -- hashes are never mislabelled as file hashes.
  return query select v_archive_id, 'STAGED'::text;
end
$function$;

create function private.rv2_canonical_trade_decimal(p_value numeric)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_text text;
begin
  if p_value is null then
    raise exception 'trade projection decimal unavailable' using errcode = '22023';
  end if;
  -- Protocol rv2-trade-read-model/1 fixes monetary projection output at 18
  -- decimal places. PostgreSQL numeric remains exact before this final,
  -- deterministic half-away-from-zero representation step.
  v_text := round(p_value, 18)::text;
  if position('.' in v_text) > 0 then
    v_text := regexp_replace(v_text, '0+$', '');
    v_text := regexp_replace(v_text, '\.$', '');
  end if;
  if v_text in ('-0', '') then
    return '0';
  end if;
  return v_text;
end
$function$;

create function private.rv2_project_trade_read_models(
  p_tenant_id uuid,
  p_connection_id uuid,
  p_generation bigint,
  p_published_at timestamptz
)
returns table (
  projection_sha256 text,
  source_event_count bigint,
  model_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_book record;
  v_fill record;
  v_existing_identity record;
  v_existing_model record;
  v_source_count bigint;
  v_model_count bigint := 0;
  v_direction integer;
  v_state_direction integer;
  v_position_qty numeric;
  v_position_value numeric;
  v_entry_time bigint;
  v_entry_value numeric;
  v_entry_qty numeric;
  v_first_entry_price numeric;
  v_entry_legs integer;
  v_lineage text[];
  v_exit_time bigint;
  v_exit_value numeric;
  v_exit_qty numeric;
  v_first_exit_price numeric;
  v_exit_legs integer;
  v_commissions jsonb;
  v_commission_items jsonb;
  v_commission_parts text[];
  v_reported_pnl numeric;
  v_current_qty numeric;
  v_closes_exactly boolean;
  v_crosses_zero boolean;
  v_closing_qty numeric;
  v_opening_qty numeric;
  v_closing_fee numeric;
  v_opening_fee numeric;
  v_avg_entry_price numeric;
  v_entry_price numeric;
  v_exit_price numeric;
  v_trade_id text;
  v_lineage_sha256 text;
  v_payload_sha256 text;
  v_identity_material text;
  v_payload_material text;
  v_payload jsonb;
  v_projection_parts text[];
  v_projection_sha256 text;
begin
  if p_tenant_id is null or p_connection_id is null
     or coalesce(p_generation, 0) <= 0 or p_published_at is null then
    raise exception 'trade projection rejected' using errcode = '22023';
  end if;
  perform 1
    from public.rv2_generations as g
   where g.tenant_id = p_tenant_id
     and g.connection_id = p_connection_id
     and g.generation = p_generation
     and g.published_at = p_published_at;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;

  select e.projection_sha256, e.source_event_count, e.model_count
    into v_projection_sha256, v_source_count, v_model_count
    from private.rv2_trade_projection_evidence as e
   where e.tenant_id = p_tenant_id
     and e.connection_id = p_connection_id
     and e.generation = p_generation;
  if found then
    return query select v_projection_sha256, v_source_count, v_model_count;
    return;
  end if;

  -- Only fills at or below a persisted trusted partition watermark are eligible.
  -- Provider identity is qualified by symbol because Binance trade ids are not
  -- assumed globally unique across symbols.
  if exists (
    select 1
      from public.rv2_source_events as e
      join private.rv2_sync_jobs as j
        on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
      join private.rv2_sync_coverage as c
        on c.tenant_id = j.tenant_id
       and c.connection_id = j.connection_id
       and c.dataset = j.dataset
       and c.partition_key = j.partition_key
     where e.tenant_id = p_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset = 'fills'
       and e.source_observed_at <= p_published_at
       and c.trusted_through is not null
       and e.event_time <= c.trusted_through
       and (
         e.event_body ->> 'id' !~ '^(0|[1-9][0-9]{0,39})$'
         or e.event_body ->> 'symbol' !~ '^[A-Z0-9]{2,24}(USDT|USDC)$'
         or e.event_body ->> 'pair' <> e.event_body ->> 'symbol'
         or e.event_body ->> 'baseQty' <> '0'
         or e.event_body ->> 'quoteQty' !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
         or (e.event_body ->> 'quoteQty')::numeric <= 0
         or e.event_body ->> 'side' not in ('BUY', 'SELL')
         or e.event_body ->> 'positionSide' not in ('BOTH', 'LONG', 'SHORT')
         or e.event_body ->> 'time' !~ '^[0-9]{13}$'
         or e.event_body ->> 'price' !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
         or (e.event_body ->> 'price')::numeric <= 0
         or e.event_body ->> 'qty' !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
         or (e.event_body ->> 'qty')::numeric <= 0
         or e.event_body ->> 'commission' !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
         or e.event_body ->> 'realizedPnl' !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,24})?$'
         or e.event_body ->> 'commissionAsset' !~ '^[A-Z0-9]{2,16}$'
         or e.event_body ->> 'realizedPnlAsset' not in ('USDT', 'USDC')
         or not (
           ((e.event_body ->> 'symbol') like '%USDT'
             and (e.event_body ->> 'realizedPnlAsset') = 'USDT')
           or ((e.event_body ->> 'symbol') like '%USDC'
             and (e.event_body ->> 'realizedPnlAsset') = 'USDC')
         )
         or e.provider_event_id <> 'binance-usdm:fills:'
              || (e.event_body ->> 'symbol') || ':' || (e.event_body ->> 'id')
       )
  ) then
    raise exception 'trade projection source invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.rv2_source_events as e
      join private.rv2_sync_jobs as j
        on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
      join private.rv2_sync_coverage as c
        on c.tenant_id = j.tenant_id
       and c.connection_id = j.connection_id
       and c.dataset = j.dataset
       and c.partition_key = j.partition_key
     where e.tenant_id = p_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset = 'fills'
       and e.source_observed_at <= p_published_at
       and c.trusted_through is not null
       and e.event_time <= c.trusted_through
     group by e.event_body ->> 'symbol', e.event_body ->> 'positionSide'
    having count(distinct e.event_body ->> 'realizedPnlAsset') <> 1
  ) then
    raise exception 'trade projection asset conflict' using errcode = '22023';
  end if;

  select count(*) into v_source_count
    from public.rv2_source_events as e
    join private.rv2_sync_jobs as j
      on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
    join private.rv2_sync_coverage as c
      on c.tenant_id = j.tenant_id
     and c.connection_id = j.connection_id
     and c.dataset = j.dataset
     and c.partition_key = j.partition_key
   where e.tenant_id = p_tenant_id
     and e.connection_id = p_connection_id
     and e.dataset = 'fills'
     and e.source_observed_at <= p_published_at
     and c.trusted_through is not null
     and e.event_time <= c.trusted_through;

  for v_book in
    select distinct e.event_body ->> 'symbol' as symbol,
           e.event_body ->> 'positionSide' as position_side,
           e.event_body ->> 'realizedPnlAsset' as currency
      from public.rv2_source_events as e
      join private.rv2_sync_jobs as j
        on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
      join private.rv2_sync_coverage as c
        on c.tenant_id = j.tenant_id
       and c.connection_id = j.connection_id
       and c.dataset = j.dataset
       and c.partition_key = j.partition_key
     where e.tenant_id = p_tenant_id
       and e.connection_id = p_connection_id
       and e.dataset = 'fills'
       and e.source_observed_at <= p_published_at
       and c.trusted_through is not null
       and e.event_time <= c.trusted_through
     order by 1 collate "C", 2 collate "C", 3 collate "C"
  loop
    v_state_direction := null;
    v_position_qty := 0;
    v_position_value := 0;
    v_lineage := array[]::text[];

    for v_fill in
      select e.provider_event_id,
             (e.event_body ->> 'time')::bigint as fill_time,
             e.event_body ->> 'side' as side,
             (e.event_body ->> 'price')::numeric as price,
             (e.event_body ->> 'qty')::numeric as qty,
             (e.event_body ->> 'commission')::numeric as commission,
             e.event_body ->> 'commissionAsset' as commission_asset,
             (e.event_body ->> 'realizedPnl')::numeric as realized_pnl
        from public.rv2_source_events as e
        join private.rv2_sync_jobs as j
          on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
        join private.rv2_sync_coverage as c
          on c.tenant_id = j.tenant_id
         and c.connection_id = j.connection_id
         and c.dataset = j.dataset
         and c.partition_key = j.partition_key
       where e.tenant_id = p_tenant_id
         and e.connection_id = p_connection_id
         and e.dataset = 'fills'
         and e.source_observed_at <= p_published_at
         and c.trusted_through is not null
         and e.event_time <= c.trusted_through
         and e.event_body ->> 'symbol' = v_book.symbol
         and e.event_body ->> 'positionSide' = v_book.position_side
         and e.event_body ->> 'realizedPnlAsset' = v_book.currency
       order by (e.event_body ->> 'time')::bigint,
                length(e.event_body ->> 'id'), e.event_body ->> 'id' collate "C"
    loop
      v_direction := case when v_fill.side = 'BUY' then 1 else -1 end;
      if v_state_direction is null then
        if (v_book.position_side = 'LONG' and v_direction <> 1)
           or (v_book.position_side = 'SHORT' and v_direction <> -1) then
          raise exception 'trade projection hedge direction invalid' using errcode = '22023';
        end if;
        v_state_direction := v_direction;
        v_position_qty := v_direction * v_fill.qty;
        v_position_value := v_fill.price * v_fill.qty;
        v_entry_time := v_fill.fill_time;
        v_entry_value := v_fill.price * v_fill.qty;
        v_entry_qty := v_fill.qty;
        v_first_entry_price := v_fill.price;
        v_entry_legs := 1;
        v_lineage := array[v_fill.provider_event_id];
        v_exit_value := 0;
        v_exit_qty := 0;
        v_first_exit_price := null;
        v_exit_legs := 0;
        v_commissions := jsonb_build_object(v_fill.commission_asset, v_fill.commission);
        v_reported_pnl := v_fill.realized_pnl;
        continue;
      end if;

      if v_state_direction = v_direction then
        v_position_qty := v_position_qty + v_direction * v_fill.qty;
        v_position_value := v_position_value + v_fill.price * v_fill.qty;
        v_entry_value := v_entry_value + v_fill.price * v_fill.qty;
        v_entry_qty := v_entry_qty + v_fill.qty;
        v_entry_legs := v_entry_legs + 1;
        v_lineage := array_append(v_lineage, v_fill.provider_event_id);
        v_commissions := jsonb_set(
          v_commissions,
          array[v_fill.commission_asset],
          to_jsonb(coalesce((v_commissions ->> v_fill.commission_asset)::numeric, 0)
            + v_fill.commission),
          true
        );
        v_reported_pnl := v_reported_pnl + v_fill.realized_pnl;
        continue;
      end if;

      v_current_qty := abs(v_position_qty);
      v_closes_exactly := v_current_qty = v_fill.qty;
      v_crosses_zero := not v_closes_exactly and v_fill.qty > v_current_qty;
      if v_crosses_zero and v_book.position_side <> 'BOTH' then
        raise exception 'trade projection hedge over-close' using errcode = '22023';
      end if;
      v_closing_qty := case when v_closes_exactly or v_crosses_zero
        then v_current_qty else v_fill.qty end;
      v_opening_qty := case when v_crosses_zero
        then v_fill.qty - v_current_qty else 0 end;
      v_closing_fee := case when v_closes_exactly then v_fill.commission
        else v_fill.commission * (v_closing_qty / v_fill.qty) end;
      v_opening_fee := v_fill.commission - v_closing_fee;
      v_avg_entry_price := v_position_value / v_current_qty;
      v_lineage := array_append(v_lineage, v_fill.provider_event_id);
      v_commissions := jsonb_set(
        v_commissions,
        array[v_fill.commission_asset],
        to_jsonb(coalesce((v_commissions ->> v_fill.commission_asset)::numeric, 0)
          + v_closing_fee),
        true
      );
      v_reported_pnl := v_reported_pnl + v_fill.realized_pnl;
      v_position_value := v_position_value - v_avg_entry_price * v_closing_qty;
      v_exit_value := v_exit_value + v_fill.price * v_closing_qty;
      v_exit_qty := v_exit_qty + v_closing_qty;
      if v_exit_legs = 0 then v_first_exit_price := v_fill.price; end if;
      v_exit_legs := v_exit_legs + 1;

      if v_closes_exactly or v_crosses_zero then
        v_exit_time := v_fill.fill_time;
        v_entry_price := case when v_entry_legs = 1
          then v_first_entry_price else v_entry_value / v_entry_qty end;
        v_exit_price := case when v_exit_legs = 1
          then v_first_exit_price else v_exit_value / v_exit_qty end;
        v_identity_material := array_to_string(array[
          'rv2-trade-id/1', 'binance', 'usdm', v_book.symbol,
          case when v_state_direction > 0 then 'LONG' else 'SHORT' end,
          v_book.position_side, v_entry_time::text, v_exit_time::text
        ] || v_lineage, chr(0));
        v_trade_id := 't_' || substr(encode(extensions.digest(
          convert_to(v_identity_material, 'utf8'), 'sha256'
        ), 'hex'), 1, 16);
        v_lineage_sha256 := encode(extensions.digest(convert_to(
          array_to_string(array['rv2-trade-lineage/1'] || v_lineage, chr(0)),
          'utf8'
        ), 'sha256'), 'hex');
        select coalesce(jsonb_agg(jsonb_build_object(
                 'asset', fees.key,
                 'amount', private.rv2_canonical_trade_decimal(fees.value::numeric)
               ) order by fees.key collate "C"), '[]'::jsonb)
          into v_commission_items
          from jsonb_each_text(v_commissions) as fees;
        select coalesce(array_agg(parts.part order by parts.asset collate "C", parts.ordinal), array[]::text[])
          into v_commission_parts
          from (
            select item ->> 'asset' as asset, 1 as ordinal, item ->> 'asset' as part
              from jsonb_array_elements(v_commission_items) as item
            union all
            select item ->> 'asset' as asset, 2 as ordinal, item ->> 'amount' as part
              from jsonb_array_elements(v_commission_items) as item
          ) as parts;
        v_payload := jsonb_build_object(
          'id', v_trade_id,
          'symbol', v_book.symbol,
          'side', case when v_state_direction > 0 then 'LONG' else 'SHORT' end,
          'positionSide', v_book.position_side,
          'entryTime', v_entry_time,
          'exitTime', v_exit_time,
          'entryPrice', private.rv2_canonical_trade_decimal(v_entry_price),
          'exitPrice', private.rv2_canonical_trade_decimal(v_exit_price),
          'qty', private.rv2_canonical_trade_decimal(v_entry_qty),
          'notional', private.rv2_canonical_trade_decimal(v_entry_price * v_entry_qty),
          'realizedPnl', private.rv2_canonical_trade_decimal(v_reported_pnl),
          'realizedPnlAsset', v_book.currency,
          'commissionByAsset', v_commission_items,
          'source', 'binance'
        );
        v_payload_material := array_to_string(array[
          'rv2-trade-payload/1',
          v_payload ->> 'id', v_payload ->> 'symbol', v_payload ->> 'side',
          v_payload ->> 'positionSide', v_payload ->> 'entryTime', v_payload ->> 'exitTime',
          v_payload ->> 'entryPrice', v_payload ->> 'exitPrice', v_payload ->> 'qty',
          v_payload ->> 'notional', v_payload ->> 'realizedPnl',
          v_payload ->> 'realizedPnlAsset'
        ] || v_commission_parts || array[v_payload ->> 'source'], chr(0));
        v_payload_sha256 := encode(extensions.digest(
          convert_to(v_payload_material, 'utf8'), 'sha256'
        ), 'hex');

        select i.* into v_existing_identity
          from public.rv2_trade_identities as i
         where i.tenant_id = p_tenant_id
           and i.connection_id = p_connection_id
           and (i.trade_id = v_trade_id or i.source_lineage_sha256 = v_lineage_sha256)
         limit 1;
        if found and (
          v_existing_identity.trade_id <> v_trade_id
          or v_existing_identity.source_lineage_sha256 <> v_lineage_sha256
        ) then
          raise exception 'trade identity conflict' using errcode = '40001';
        end if;
        if not found then
          insert into public.rv2_trade_identities (
            tenant_id, connection_id, trade_id, id_protocol,
            source_lineage_sha256, first_generation, first_seen_at
          ) values (
            p_tenant_id, p_connection_id, v_trade_id, 'rv2-trade-id/1',
            v_lineage_sha256, p_generation, p_published_at
          );
        end if;

        select m.* into v_existing_model
          from public.rv2_trade_read_models as m
         where m.tenant_id = p_tenant_id
           and m.connection_id = p_connection_id
           and m.trade_id = v_trade_id
           and m.generation = p_generation;
        if found and v_existing_model.payload_sha256 <> v_payload_sha256 then
          raise exception 'trade read model conflict' using errcode = '40001';
        end if;
        if not found then
          insert into public.rv2_trade_read_models (
            tenant_id, connection_id, trade_id, generation, model_protocol,
            payload, payload_sha256, projected_at
          ) values (
            p_tenant_id, p_connection_id, v_trade_id, p_generation,
            'rv2-trade-read-model/1', v_payload, v_payload_sha256, p_published_at
          );
        end if;
        v_model_count := v_model_count + 1;

        if v_crosses_zero then
          v_state_direction := v_direction;
          v_position_qty := v_direction * v_opening_qty;
          v_position_value := v_fill.price * v_opening_qty;
          v_entry_time := v_fill.fill_time;
          v_entry_value := v_fill.price * v_opening_qty;
          v_entry_qty := v_opening_qty;
          v_first_entry_price := v_fill.price;
          v_entry_legs := 1;
          v_lineage := array[v_fill.provider_event_id];
          v_exit_value := 0;
          v_exit_qty := 0;
          v_first_exit_price := null;
          v_exit_legs := 0;
          v_commissions := jsonb_build_object(v_fill.commission_asset, v_opening_fee);
          v_reported_pnl := 0;
        else
          v_state_direction := null;
          v_position_qty := 0;
          v_position_value := 0;
          v_lineage := array[]::text[];
        end if;
      else
        v_position_qty := v_state_direction * (v_current_qty - v_fill.qty);
      end if;
    end loop;
  end loop;

  select array['rv2-trade-read-model/1', p_generation::text]
         || coalesce(array_agg(part order by exit_time, trade_id, ordinal), array[]::text[])
    into v_projection_parts
    from (
      select m.trade_id, (m.payload ->> 'exitTime')::bigint as exit_time,
             valueset.part, valueset.ordinal
        from public.rv2_trade_read_models as m
        join public.rv2_trade_identities as i
          on i.tenant_id = m.tenant_id
         and i.connection_id = m.connection_id
         and i.trade_id = m.trade_id
        cross join lateral unnest(array[
          m.trade_id,
          i.source_lineage_sha256,
          m.payload_sha256
        ]) with ordinality as valueset(part, ordinal)
       where m.tenant_id = p_tenant_id
         and m.connection_id = p_connection_id
         and m.generation = p_generation
    ) as projection_rows;
  v_projection_sha256 := encode(extensions.digest(convert_to(
    array_to_string(v_projection_parts, chr(0)), 'utf8'
  ), 'sha256'), 'hex');
  insert into private.rv2_trade_projection_evidence (
    tenant_id, connection_id, generation, projector_protocol,
    source_event_count, model_count, projection_sha256, projected_at
  ) values (
    p_tenant_id, p_connection_id, p_generation, 'rv2-trade-projector/1',
    v_source_count, v_model_count, v_projection_sha256, p_published_at
  );
  return query select v_projection_sha256, v_source_count, v_model_count;
end
$function$;

create function public.rv2_service_publish_generation(
  p_worker_subject uuid,
  p_connection_id uuid,
  p_expected_generation bigint,
  p_credential_version bigint,
  p_job_ids uuid[]
)
returns table (
  generation_id uuid,
  generation bigint,
  status text,
  published_at timestamptz,
  manifest_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_connection record;
  v_generation_id uuid;
  v_generation bigint;
  v_published_at timestamptz;
  v_job_ids uuid[];
  v_job_count integer;
  v_source_root_sha256 text;
  v_source_event_count bigint;
  v_projection_sha256 text;
  v_projection_source_count bigint;
  v_trade_model_count bigint;
  v_coverage jsonb;
  v_reconciliation jsonb;
  v_capabilities jsonb;
  v_manifest_sha256 text;
begin
  perform private.rv2_require_service_role();
  if p_worker_subject is null
     or coalesce(p_expected_generation, -1) < 0
     or coalesce(p_credential_version, 0) <= 0
     or p_job_ids is null
     or cardinality(p_job_ids) not between 1 and 128 then
    raise exception 'generation publish rejected' using errcode = '22023';
  end if;
  -- No caller-supplied reconciliation or capability document is accepted.
  -- Until persisted real-generation oracle evidence proves seven consecutive
  -- parity generations, the database-authoritative state remains fail closed.
  v_reconciliation := jsonb_build_object(
    'protocol', 'rv-reconciliation/2',
    'status', 'UNKNOWN',
    'reasonCodes', jsonb_build_array(
      'LEDGER_SHADOW_ONLY', 'RECONCILIATION_NOT_EVALUATED'
    ),
    'checks', '{}'::jsonb
  );
  v_capabilities := private.rv2_default_capabilities();

  select c.* into v_connection
    from public.rv2_connections as c
   where c.connection_id = p_connection_id
     and c.credential_version = p_credential_version
     and c.status = 'ACTIVE'
     and c.permission_state = 'READ_ONLY_VERIFIED'
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_connection.current_generation <> p_expected_generation then
    raise exception 'generation conflict' using errcode = '40001';
  end if;

  -- The caller's p_job_ids is compatibility-only and is never authoritative.
  -- Derive the exact delta from the locked connection and refuse to publish
  -- while any source/outbox work or identity conflict remains open.
  if exists (
    select 1 from private.rv2_sync_jobs as j
     where j.tenant_id = v_connection.tenant_id
       and j.connection_id = p_connection_id
       and j.credential_version = p_credential_version
       and j.status in ('QUEUED', 'CLAIMED')
  ) or exists (
    select 1 from private.rv2_post_commit_work as w
     where w.tenant_id = v_connection.tenant_id
       and w.connection_id = p_connection_id
       and w.credential_version = p_credential_version
       and w.status <> 'DONE'
  ) or exists (
    select 1 from private.rv2_sync_jobs as j
     where j.tenant_id = v_connection.tenant_id
       and j.connection_id = p_connection_id
       and j.credential_version = p_credential_version
       and j.status = 'SUCCEEDED'
       and j.page_committed = true
       and (
         select count(*)
           from private.rv2_post_commit_work as expected_work
          where expected_work.tenant_id = j.tenant_id
            and expected_work.job_id = j.job_id
       ) <> j.page_number
  ) or exists (
    select 1 from private.rv2_source_event_conflicts as conflict
     where conflict.tenant_id = v_connection.tenant_id
       and conflict.connection_id = p_connection_id
       and conflict.status = 'OPEN'
  ) then
    return;
  end if;

  select array_agg(j.job_id order by j.completed_at, j.job_id), count(*)
    into v_job_ids, v_job_count
    from private.rv2_sync_jobs as j
    join public.rv2_memberships as m
      on m.tenant_id = j.tenant_id and m.user_id = j.requested_by
   where j.tenant_id = v_connection.tenant_id
     and j.connection_id = p_connection_id
     and j.credential_version = p_credential_version
     and j.status = 'SUCCEEDED'
     and j.page_committed = true
     and m.status = 'ACTIVE'
     and not exists (
       select 1 from public.rv2_generations as published_generation
        where published_generation.tenant_id = j.tenant_id
          and published_generation.connection_id = j.connection_id
          and j.job_id = any (published_generation.source_job_ids)
     )
     and (
       select count(*)
         from private.rv2_post_commit_work as expected_work
        where expected_work.tenant_id = j.tenant_id
          and expected_work.job_id = j.job_id
          and expected_work.status = 'DONE'
     ) = j.page_number
     and not exists (
       select 1 from private.rv2_post_commit_work as w
        where w.tenant_id = j.tenant_id
          and w.job_id = j.job_id
          and w.status <> 'DONE'
     );
  if v_job_count = 0 then
    return;
  end if;
  if v_job_count > 128 then
    raise exception 'generation source delta too large' using errcode = '54000';
  end if;

  v_published_at := statement_timestamp();
  select count(*), encode(extensions.digest(convert_to(
           'rv2-source-root/1' || chr(0) || coalesce(string_agg(
             e.dataset || chr(0) || e.provider_event_id || chr(0)
               || e.event_sha256 || chr(0)
               || floor(extract(epoch from e.event_time) * 1000000)::numeric::text,
             chr(0) order by e.dataset collate "C", e.provider_event_id collate "C"
           ), ''),
           'utf8'
         ), 'sha256'), 'hex')
    into v_source_event_count, v_source_root_sha256
    from public.rv2_source_events as e
    join private.rv2_sync_jobs as j
      on j.tenant_id = e.tenant_id and j.job_id = e.sync_job_id
    join private.rv2_sync_coverage as c
      on c.tenant_id = j.tenant_id
     and c.connection_id = j.connection_id
     and c.dataset = j.dataset
     and c.partition_key = j.partition_key
   where e.tenant_id = v_connection.tenant_id
     and e.connection_id = p_connection_id
     and e.source_observed_at <= v_published_at
     and c.trusted_through is not null
     and e.event_time <= c.trusted_through;

  v_coverage := private.rv2_coverage_document(v_connection.tenant_id, p_connection_id);

  v_generation := p_expected_generation + 1;
  v_generation_id := gen_random_uuid();
  -- The row is still transaction-private. A fixed-width placeholder allows
  -- the generation FK required by the projector; it is replaced by the final
  -- source+projection-bound manifest before the transaction can commit.
  v_projection_sha256 := repeat('0', 64);
  v_trade_model_count := 0;
  v_manifest_sha256 := repeat('0', 64);

  update public.rv2_generations as g
     set status = 'SUPERSEDED'
   where g.tenant_id = v_connection.tenant_id
     and g.connection_id = p_connection_id
     and g.status = 'PUBLISHED';
  update public.rv2_ledger_generations as l
     set status = 'SUPERSEDED', updated_at = v_published_at
   where l.tenant_id = v_connection.tenant_id
     and l.connection_id = p_connection_id
     and l.status <> 'SUPERSEDED';
  update public.rv2_reconciliation_generations as r
     set state = 'SUPERSEDED', updated_at = v_published_at
   where r.tenant_id = v_connection.tenant_id
     and r.connection_id = p_connection_id
     and r.state <> 'SUPERSEDED';

  insert into public.rv2_generations (
    tenant_id, connection_id, generation, generation_id, credential_version,
    source_job_ids, coverage, reconciliation, capabilities,
    source_root_sha256, source_event_count, projection_sha256,
    trade_model_count, manifest_sha256, status, published_at
  ) values (
    v_connection.tenant_id, p_connection_id, v_generation, v_generation_id,
    p_credential_version, v_job_ids, v_coverage, v_reconciliation,
    v_capabilities, v_source_root_sha256, v_source_event_count,
    v_projection_sha256, v_trade_model_count, v_manifest_sha256,
    'PUBLISHED', v_published_at
  );
  -- This function is one PostgreSQL transaction.  The PUBLISHED row remains
  -- invisible until projection evidence and the current-generation CAS both
  -- succeed; any projector failure rolls the generation insert back.
  perform * from private.rv2_project_trade_read_models(
    v_connection.tenant_id, p_connection_id, v_generation, v_published_at
  );
  select evidence.projection_sha256, evidence.source_event_count, evidence.model_count
    into v_projection_sha256, v_projection_source_count, v_trade_model_count
    from private.rv2_trade_projection_evidence as evidence
   where evidence.tenant_id = v_connection.tenant_id
     and evidence.connection_id = p_connection_id
     and evidence.generation = v_generation;
  if not found then
    raise exception 'trade projection evidence unavailable' using errcode = '55000';
  end if;
  if v_projection_source_count > v_source_event_count
     or v_trade_model_count > v_projection_source_count then
    raise exception 'trade projection evidence inconsistent' using errcode = '22023';
  end if;
  -- A trusted closed lifecycle may be browsed and reviewed even while every
  -- account-level or analytical capability remains locked. The model count is
  -- projector-owned evidence; no caller can promote this decision.
  v_capabilities := jsonb_build_object(
    'recordsBrowsable', jsonb_build_object(
      'decision', case when v_trade_model_count > 0 then 'LIMITED' else 'DENY' end,
      'reasonCodes', case when v_trade_model_count > 0
        then jsonb_build_array('TRUSTED_RECORDS_ONLY', 'RECONCILIATION_UNKNOWN')
        else jsonb_build_array('NO_CLOSED_TRADES') end
    ),
    'observedTradeAnalytics', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('RECONCILIATION_UNKNOWN')
    ),
    'accountKpis', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('RECONCILIATION_UNKNOWN')
    ),
    'currentPositions', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('COVERAGE_INCOMPLETE')
    ),
    'equityAnalytics', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('RECONCILIATION_UNKNOWN')
    ),
    'ledger', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('LEDGER_SHADOW_ONLY')
    ),
    'experiments', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('RECONCILIATION_UNKNOWN')
    ),
    'ai', jsonb_build_object(
      'decision', 'DENY', 'reasonCodes', jsonb_build_array('RECONCILIATION_UNKNOWN')
    )
  );
  if not private.rv2_reconciliation_is_valid(v_reconciliation)
     or not private.rv2_capabilities_are_valid(v_capabilities) then
    raise exception 'generation trust document invalid' using errcode = '22023';
  end if;
  v_manifest_sha256 := encode(extensions.digest(convert_to(jsonb_build_object(
    'protocol', 'rv2-generation-manifest/1',
    'generation', v_generation,
    'coverage', v_coverage,
    'reconciliation', v_reconciliation,
    'capabilities', v_capabilities,
    'snapshotThrough', v_published_at,
    'sourceJobIds', to_jsonb(v_job_ids),
    'sourceRootSha256', v_source_root_sha256,
    'sourceEventCount', v_source_event_count,
    'tradeProjectionSha256', v_projection_sha256,
    'tradeProjectionSourceCount', v_projection_source_count,
    'tradeModelCount', v_trade_model_count
  )::text, 'utf8'), 'sha256'), 'hex');
  update public.rv2_generations as g
     set capabilities = v_capabilities,
         projection_sha256 = v_projection_sha256,
         trade_model_count = v_trade_model_count,
         manifest_sha256 = v_manifest_sha256
   where g.tenant_id = v_connection.tenant_id
     and g.connection_id = p_connection_id
     and g.generation = v_generation
     and g.manifest_sha256 = repeat('0', 64);
  if not found then
    raise exception 'generation manifest finalization conflict' using errcode = '40001';
  end if;
  insert into public.rv2_reconciliation_generations (
    tenant_id, connection_id, generation, state, status, reason_codes, checks,
    created_at, updated_at
  ) values (
    v_connection.tenant_id, p_connection_id, v_generation, 'FINAL',
    v_reconciliation ->> 'status',
    array(select jsonb_array_elements_text(v_reconciliation -> 'reasonCodes')),
    v_reconciliation -> 'checks', v_published_at, v_published_at
  );
  insert into public.rv2_ledger_generations (
    tenant_id, connection_id, generation, status, reason_codes,
    created_at, updated_at
  ) values (
    v_connection.tenant_id, p_connection_id, v_generation,
    'SHADOW_PENDING', array['LEDGER_SHADOW_ONLY'], v_published_at, v_published_at
  );
  update public.rv2_connections as c
     set current_generation = v_generation,
         updated_at = v_published_at
   where c.connection_id = p_connection_id
     and c.credential_version = p_credential_version
     and c.current_generation = p_expected_generation;
  if not found then
    raise exception 'generation conflict' using errcode = '40001';
  end if;

  return query select
    v_generation_id, v_generation, 'PUBLISHED'::text,
    v_published_at, v_manifest_sha256;
end
$function$;

create function public.rv2_service_delete_tenant_data(
  p_subject uuid,
  p_tenant_id uuid,
  p_expected_membership_version bigint
)
returns table (
  tenant_id uuid,
  receipt_id uuid,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_tenant record;
  v_membership record;
  v_receipt_id uuid;
  v_deleted_at timestamptz;
begin
  if p_subject is null or p_tenant_id is null
     or coalesce(p_expected_membership_version, 0) <= 0 then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-delete:' || p_tenant_id::text,
    0
  ));
  select t.* into v_tenant
    from public.rv2_tenants as t
   where t.tenant_id = p_tenant_id
   for update;
  select m.* into v_membership
    from public.rv2_memberships as m
   where m.tenant_id = p_tenant_id
     and m.user_id = p_subject
     and m.member_role = 'OWNER'
   for update;
  if v_tenant.tenant_id is null or v_membership.user_id is null then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_tenant.status = 'DELETED' then
    return query select p_tenant_id, v_tenant.deletion_receipt_id, v_tenant.deleted_at;
    return;
  end if;
  perform private.rv2_require_service_membership(p_subject, p_tenant_id);
  if v_membership.membership_version <> p_expected_membership_version then
    raise exception 'membership version conflict' using errcode = '40001';
  end if;

  v_receipt_id := gen_random_uuid();
  v_deleted_at := statement_timestamp();
  delete from private.rv2_egress_receipts as e where e.tenant_id = p_tenant_id;
  delete from private.rv2_backup_runs as b where b.tenant_id = p_tenant_id;
  delete from public.rv2_connections as c where c.tenant_id = p_tenant_id;
  insert into private.rv2_deletion_tombstones (
    tenant_id, receipt_id, subject_id, operation, deleted_at, backup_purge_after
  ) values (
    p_tenant_id, v_receipt_id, p_subject, 'DELETE_ACCOUNT',
    v_deleted_at, v_deleted_at + interval '30 days'
  );
  update public.rv2_memberships as m
     set status = 'DELETED',
         membership_version = m.membership_version + 1,
         updated_at = v_deleted_at
   where m.tenant_id = p_tenant_id;
  update public.rv2_tenants as t
     set status = 'DELETED',
         deletion_receipt_id = v_receipt_id,
         deleted_at = v_deleted_at
   where t.tenant_id = p_tenant_id;
  return query select p_tenant_id, v_receipt_id, v_deleted_at;
end
$function$;

create function public.rv2_ops_claim_oidc_jti(
  p_capability text,
  p_oidc_jti text,
  p_expires_at timestamptz,
  p_binding jsonb
)
returns table (claimed boolean, first_use boolean, oidc_jti_sha256 text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_key_count integer;
  v_jti_sha256 text;
  v_binding_sha256 text;
  v_inserted integer;
begin
  perform private.rv2_require_service_role();
  if p_capability not in ('beta-backup', 'beta-archive', 'beta-capacity-observe')
     or p_oidc_jti !~ '^[A-Za-z0-9._:-]{8,256}$'
     or p_expires_at <= statement_timestamp()
     or p_expires_at > statement_timestamp() + interval '10 minutes'
     or jsonb_typeof(p_binding) <> 'object'
     or not (p_binding ?& array[
       'repository', 'ref', 'workflowRef', 'jobWorkflowRef',
       'runId', 'runAttempt', 'job'
     ]) then
    raise exception 'OIDC claim rejected' using errcode = '22023';
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_binding);
  if v_key_count <> 7
     or p_binding ->> 'repository' <> 'player1314520/trading-'
     or p_binding ->> 'ref' <> 'refs/heads/main'
     or p_binding ->> 'jobWorkflowRef' <> p_binding ->> 'workflowRef'
     or p_binding ->> 'runId' !~ '^[1-9][0-9]{0,19}$'
     or p_binding ->> 'runAttempt' !~ '^[1-9][0-9]{0,9}$'
     or p_binding ->> 'job' <> case p_capability
       when 'beta-archive' then 'archive' else 'backup' end
     or p_binding ->> 'workflowRef' <> 'player1314520/trading-/.github/workflows/'
       || case p_capability when 'beta-archive' then 'beta-archive.yml' else 'beta-backup.yml' end
       || '@refs/heads/main' then
    raise exception 'OIDC claim rejected' using errcode = '22023';
  end if;

  v_jti_sha256 := encode(extensions.digest(convert_to(p_oidc_jti, 'utf8'), 'sha256'), 'hex');
  v_binding_sha256 := encode(extensions.digest(convert_to(p_binding::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-ops-oidc:' || p_capability || ':'
    || (p_binding ->> 'runId') || ':' || (p_binding ->> 'runAttempt'),
    0
  ));
  if exists (
    select 1 from private.rv2_ops_oidc_claims as prior
     where prior.capability = p_capability
       and prior.run_id = p_binding ->> 'runId'
       and prior.run_attempt = p_binding ->> 'runAttempt'
  ) then
    return query select false, false, v_jti_sha256;
    return;
  end if;
  insert into private.rv2_ops_oidc_claims (
    oidc_jti_sha256, capability, expires_at, binding, binding_sha256,
    repository, git_ref, workflow_ref, run_id, run_attempt, job_name
  ) values (
    v_jti_sha256, p_capability, p_expires_at, p_binding, v_binding_sha256,
    p_binding ->> 'repository', p_binding ->> 'ref', p_binding ->> 'workflowRef',
    p_binding ->> 'runId', p_binding ->> 'runAttempt', p_binding ->> 'job'
  ) on conflict (oidc_jti_sha256) do nothing;
  get diagnostics v_inserted = row_count;
  return query select v_inserted = 1, v_inserted = 1, v_jti_sha256;
end
$function$;

create function public.rv2_ops_read_backup_page(
  p_run_id text,
  p_run_attempt text,
  p_cursor text,
  p_limit integer,
  p_view text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_snapshot record;
  v_snapshot_id text;
  v_generation bigint;
  v_cursor_parts text[];
  v_dataset_index integer := 0;
  v_offset bigint := 0;
  v_last_ordinal bigint;
  v_dataset text;
  v_rows jsonb;
  v_next_cursor text;
  v_datasets text[] := array[
    'trades', 'income', 'orders', 'algo_orders', 'force_orders', 'balances',
    'positions', 'reviews', 'actions', 'journal_entries', 'risk_rules',
    'reports', 'source_events', 'generations', 'connections', 'memberships', 'tenants',
    'ledger_generations', 'reconciliation_generations', 'deletion_tombstones'
  ];
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_limit <> 1000
     or p_view <> 'beta_backup_v1'
     or (p_cursor is not null and (
       length(p_cursor) not between 1 and 512 or p_cursor ~ '[[:cntrl:]]'
     )) then
    raise exception 'backup page rejected' using errcode = '22023';
  end if;
  perform 1
    from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-backup'
     and claim.run_id = p_run_id
     and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-ops-backup-snapshot:' || p_run_id || ':' || p_run_attempt,
    0
  ));
  select s.* into v_snapshot
    from private.rv2_ops_backup_snapshots as s
   where s.run_id = p_run_id and s.run_attempt = p_run_attempt
   for update;
  if not found then
    v_snapshot_id := replace(gen_random_uuid()::text, '-', '');
    select coalesce(max(c.current_generation), 0) into v_generation
      from public.rv2_connections as c;
    insert into private.rv2_ops_backup_snapshots (
      snapshot_id, run_id, run_attempt, snapshot_epoch, generation
    ) values (
      v_snapshot_id, p_run_id, p_run_attempt, statement_timestamp(), v_generation
    ) returning * into v_snapshot;
    perform private.rv2_ops_materialize_backup_snapshot(
      v_snapshot.snapshot_id, v_snapshot.snapshot_epoch, v_snapshot.generation
    );
    select s.* into v_snapshot
      from private.rv2_ops_backup_snapshots as s
     where s.snapshot_id = v_snapshot_id;
  end if;
  if v_snapshot.status not in ('READY', 'SIGNED')
     or v_snapshot.expires_at <= statement_timestamp() then
    raise exception 'backup snapshot unavailable' using errcode = '55000';
  end if;

  if p_cursor is not null then
    v_cursor_parts := regexp_match(p_cursor, '^([a-f0-9]{32}):([0-9]{1,2}):([0-9]{1,12})$');
    if v_cursor_parts is null or v_cursor_parts[1] <> v_snapshot.snapshot_id then
      raise exception 'backup cursor rejected' using errcode = '22023';
    end if;
    v_dataset_index := v_cursor_parts[2]::integer;
    v_offset := v_cursor_parts[3]::bigint;
  end if;
  if v_dataset_index < 0 or v_dataset_index >= cardinality(v_datasets) then
    raise exception 'backup cursor rejected' using errcode = '22023';
  end if;
  v_dataset := v_datasets[v_dataset_index + 1];

  select coalesce(jsonb_agg(page.row_data order by page.row_ordinal), '[]'::jsonb),
         max(page.row_ordinal)
    into v_rows, v_last_ordinal
    from (
      select r.row_ordinal, r.row_data
        from private.rv2_ops_backup_snapshot_rows as r
       where r.snapshot_id = v_snapshot.snapshot_id
         and r.dataset = v_dataset
         and r.row_ordinal > v_offset
       order by r.row_ordinal
       limit p_limit
    ) as page;
  if v_last_ordinal is not null and exists (
    select 1 from private.rv2_ops_backup_snapshot_rows as remaining
     where remaining.snapshot_id = v_snapshot.snapshot_id
       and remaining.dataset = v_dataset
       and remaining.row_ordinal > v_last_ordinal
  ) then
    v_next_cursor := v_snapshot.snapshot_id || ':'
      || v_dataset_index::text || ':' || v_last_ordinal::text;
  elsif v_dataset_index + 1 < cardinality(v_datasets) then
    v_next_cursor := v_snapshot.snapshot_id || ':'
      || (v_dataset_index + 1)::text || ':0';
  else
    v_next_cursor := null;
  end if;
  return jsonb_build_object(
    'format', 'beta-backup-page/1',
    'view', 'beta_backup_v1',
    'readOnly', true,
    'snapshotId', v_snapshot.snapshot_id,
    'generation', v_snapshot.generation,
    'dataset', v_dataset,
    'rows', v_rows,
    'nextCursor', v_next_cursor
  );
end
$function$;

create function public.rv2_ops_record_backup_page_evidence(
  p_run_id text,
  p_run_attempt text,
  p_oidc_jti_sha256 text,
  p_request_cursor text,
  p_page jsonb
)
returns table (recorded boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_expected jsonb;
  v_page_sha256 text;
  v_cursor_key text := coalesce(p_request_cursor, '__FIRST__');
  v_existing record;
begin
  perform private.rv2_require_service_role();
  if p_oidc_jti_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_page) <> 'object'
     or jsonb_array_length(p_page -> 'rows') > 1000 then
    raise exception 'backup page evidence rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.oidc_jti_sha256 = p_oidc_jti_sha256
     and claim.capability = 'beta-backup'
     and claim.run_id = p_run_id
     and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_expected := public.rv2_ops_read_backup_page(
    p_run_id, p_run_attempt, p_request_cursor, 1000, 'beta_backup_v1'
  );
  if v_expected <> p_page then
    raise exception 'backup page evidence mismatch' using errcode = '40001';
  end if;
  v_page_sha256 := encode(extensions.digest(convert_to(p_page::text, 'utf8'), 'sha256'), 'hex');
  select e.* into v_existing
    from private.rv2_ops_backup_page_evidence as e
   where e.snapshot_id = p_page ->> 'snapshotId'
     and e.request_cursor_key = v_cursor_key;
  if found then
    if v_existing.page_sha256 <> v_page_sha256
       or v_existing.oidc_jti_sha256 <> p_oidc_jti_sha256 then
      raise exception 'backup page request fingerprint conflict' using errcode = '40001';
    end if;
    return query select true;
    return;
  end if;
  insert into private.rv2_ops_backup_page_evidence (
    snapshot_id, run_id, run_attempt, oidc_jti_sha256,
    request_cursor, request_cursor_key, next_cursor, dataset,
    generation, row_count, page_sha256
  ) values (
    p_page ->> 'snapshotId', p_run_id, p_run_attempt, p_oidc_jti_sha256,
    p_request_cursor, v_cursor_key, p_page ->> 'nextCursor', p_page ->> 'dataset',
    (p_page ->> 'generation')::bigint, jsonb_array_length(p_page -> 'rows'),
    v_page_sha256
  );
  return query select true;
end
$function$;

create function public.rv2_ops_claim_backup_signing_evidence(
  p_run_id text,
  p_run_attempt text,
  p_oidc_jti_sha256 text,
  p_scope_prefix text,
  p_snapshot_id text,
  p_generation bigint,
  p_row_counts jsonb,
  p_object_key text,
  p_object_bytes bigint,
  p_object_sha256 text
)
returns table (
  verified boolean,
  claimed boolean,
  first_use boolean,
  snapshot_verified boolean,
  object_verified boolean,
  object_key text,
  object_bytes bigint,
  object_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_snapshot record;
  v_existing record;
  v_actual_counts jsonb;
  v_normalized_counts jsonb;
  v_snapshot_rows bigint;
  v_evidence_rows bigint;
  v_chain_pages bigint;
  v_evidence_pages bigint;
  v_terminal_pages bigint;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_oidc_jti_sha256 !~ '^[0-9a-f]{64}$'
     or p_scope_prefix <> 'beta-backups/runs/' || p_run_id
       || '/attempt-' || p_run_attempt || '/'
     or p_object_key not like p_scope_prefix || '%'
     or p_object_key ~ '(^|/)\.\.(/|$)'
     or p_object_bytes <= 0
     or p_object_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_row_counts) <> 'object' then
    raise exception 'backup signing evidence rejected' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each(p_row_counts) as item
     where item.key not in (
       'trades', 'income', 'orders', 'algo_orders', 'force_orders', 'balances',
       'positions', 'reviews', 'actions', 'journal_entries', 'risk_rules',
       'reports', 'source_events', 'generations', 'connections', 'memberships',
       'tenants', 'ledger_generations', 'reconciliation_generations',
       'deletion_tombstones'
     ) or jsonb_typeof(item.value) <> 'number'
       or item.value::text !~ '^[0-9]{1,12}$'
  ) then
    raise exception 'backup signing evidence rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.oidc_jti_sha256 = p_oidc_jti_sha256
     and claim.capability = 'beta-backup'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-ops-backup-sign:' || p_run_id || ':' || p_run_attempt, 0
  ));
  select s.* into v_snapshot
    from private.rv2_ops_backup_snapshots as s
   where s.snapshot_id = p_snapshot_id
     and s.run_id = p_run_id and s.run_attempt = p_run_attempt
     and s.generation = p_generation and s.status = 'READY'
     and s.expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'backup snapshot unavailable' using errcode = '55000';
  end if;
  select coalesce(jsonb_object_agg(counts.dataset, to_jsonb(counts.row_count)), '{}'::jsonb),
         coalesce(sum(counts.row_count), 0)
    into v_actual_counts, v_snapshot_rows
    from (
      select r.dataset, count(*)::bigint as row_count
        from private.rv2_ops_backup_snapshot_rows as r
       where r.snapshot_id = p_snapshot_id
       group by r.dataset
    ) as counts;
  select coalesce(jsonb_object_agg(item.key, item.value), '{}'::jsonb)
    into v_normalized_counts
    from jsonb_each(p_row_counts) as item
   where item.value::text <> '0';
  if v_actual_counts <> v_normalized_counts then
    raise exception 'backup row counts mismatch' using errcode = '40001';
  end if;

  with recursive chain as (
    select e.request_cursor_key, e.next_cursor, e.row_count,
           array[e.request_cursor_key]::text[] as visited
      from private.rv2_ops_backup_page_evidence as e
     where e.snapshot_id = p_snapshot_id
       and e.run_id = p_run_id and e.run_attempt = p_run_attempt
       and e.oidc_jti_sha256 = p_oidc_jti_sha256
       and e.request_cursor_key = '__FIRST__'
    union all
    select e.request_cursor_key, e.next_cursor, e.row_count,
           chain.visited || e.request_cursor_key
      from chain
      join private.rv2_ops_backup_page_evidence as e
        on e.snapshot_id = p_snapshot_id
       and e.run_id = p_run_id and e.run_attempt = p_run_attempt
       and e.oidc_jti_sha256 = p_oidc_jti_sha256
       and e.request_cursor_key = chain.next_cursor
     where chain.next_cursor is not null
       and not e.request_cursor_key = any(chain.visited)
  )
  select count(*), coalesce(sum(row_count), 0),
         count(*) filter (where next_cursor is null)
    into v_chain_pages, v_evidence_rows, v_terminal_pages
    from chain;
  select count(*) into v_evidence_pages
    from private.rv2_ops_backup_page_evidence as e
   where e.snapshot_id = p_snapshot_id
     and e.run_id = p_run_id and e.run_attempt = p_run_attempt
     and e.oidc_jti_sha256 = p_oidc_jti_sha256;
  if v_chain_pages = 0 or v_chain_pages <> v_evidence_pages
     or v_terminal_pages <> 1 or v_evidence_rows <> v_snapshot_rows then
    raise exception 'backup page evidence chain incomplete' using errcode = '55000';
  end if;
  select c.* into v_existing
    from private.rv2_ops_backup_signing_claims as c
   where c.run_id = p_run_id and c.run_attempt = p_run_attempt;
  if found then
    return query select
      true, false, false, true, true,
      v_existing.object_key, v_existing.object_bytes, v_existing.object_sha256;
    return;
  end if;
  insert into private.rv2_ops_backup_signing_claims (
    run_id, run_attempt, oidc_jti_sha256, snapshot_id, generation,
    row_counts, scope_prefix, object_key, object_bytes, object_sha256
  ) values (
    p_run_id, p_run_attempt, p_oidc_jti_sha256, p_snapshot_id, p_generation,
    p_row_counts, p_scope_prefix, p_object_key, p_object_bytes, p_object_sha256
  );
  update private.rv2_ops_backup_snapshots as s
     set status = 'SIGNED', signed_at = statement_timestamp()
   where s.snapshot_id = p_snapshot_id;
  return query select
    true, true, true, true, true,
    p_object_key, p_object_bytes, p_object_sha256;
end
$function$;

create function public.rv2_ops_apply_deletion_tombstones(
  p_restore_id text,
  p_active_generation bigint,
  p_target_generation bigint,
  p_mode text,
  p_before timestamptz
)
returns table (applied boolean, tombstones_applied integer)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_existing record;
  v_tombstones integer;
begin
  perform private.rv2_require_service_role();
  if p_restore_id !~ '^[A-Za-z0-9_-]{8,128}$'
     or p_active_generation < 0
     or p_target_generation <> p_active_generation + 1
     or p_mode <> 'new-generation'
     or p_before is null or p_before > statement_timestamp() + interval '5 minutes' then
    raise exception 'restore tombstone request rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-restore:' || p_restore_id, 0
  ));
  select r.* into v_existing from private.rv2_ops_restore_runs as r
   where r.restore_id = p_restore_id for update;
  if found then
    if v_existing.active_generation <> p_active_generation
       or v_existing.target_generation <> p_target_generation
       or v_existing.tombstone_cutoff <> p_before then
      raise exception 'restore tombstone replay conflict' using errcode = '40001';
    end if;
    return query select true, v_existing.tombstones_applied;
    return;
  end if;
  select count(*)::integer into v_tombstones
    from private.rv2_deletion_tombstones as t
   where t.deleted_at <= p_before;
  insert into private.rv2_ops_restore_runs (
    restore_id, active_generation, target_generation, tombstone_cutoff,
    tombstones_applied, tombstones_applied_at, status
  ) values (
    p_restore_id, p_active_generation, p_target_generation, p_before,
    v_tombstones, statement_timestamp(), 'TOMBSTONES_APPLIED'
  );
  return query select true, v_tombstones;
end
$function$;

create function public.rv2_ops_claim_restore_manifest(
  p_restore_id text,
  p_target_generation bigint,
  p_manifest_nonce text,
  p_manifest_sha256 text,
  p_source_repository text,
  p_source_workflow_ref text,
  p_source_run_id text,
  p_source_run_attempt text
)
returns table (accepted boolean, first_use boolean, lease_subject text)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run record;
  v_lease_subject text;
begin
  perform private.rv2_require_service_role();
  if p_manifest_nonce !~ '^[0-9a-f]{48,128}$'
     or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_repository <> 'player1314520/trading-'
     or p_source_workflow_ref <>
       'player1314520/trading-/.github/workflows/beta-backup.yml@refs/heads/main'
     or p_source_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_source_run_attempt !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'restore manifest rejected' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-restore:' || p_restore_id, 0
  ));
  select r.* into v_run from private.rv2_ops_restore_runs as r
   where r.restore_id = p_restore_id and r.target_generation = p_target_generation
     and r.tombstones_applied_at is not null
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_run.manifest_claimed_at is not null then
    return query select false, false, coalesce(v_run.lease_subject, '');
    return;
  end if;
  v_lease_subject := encode(gen_random_bytes(32), 'hex');
  update private.rv2_ops_restore_runs as r
     set manifest_nonce = p_manifest_nonce,
         manifest_sha256 = p_manifest_sha256,
         source_repository = p_source_repository,
         source_workflow_ref = p_source_workflow_ref,
         source_run_id = p_source_run_id,
         source_run_attempt = p_source_run_attempt,
         manifest_claimed_at = statement_timestamp(),
         lease_subject = v_lease_subject,
         status = 'QUARANTINED', updated_at = statement_timestamp()
   where r.restore_id = p_restore_id;
  return query select true, true, v_lease_subject;
exception when unique_violation then
  raise exception 'restore manifest replay detected' using errcode = '40001';
end
$function$;

create function public.rv2_ops_claim_archive_download(
  p_run_id text,
  p_run_attempt text
)
returns table (
  archive_id text,
  archive_sha256 text,
  archive_bytes bigint,
  download_url text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_archive record;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'archive claim rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-archive' and claim.run_id = p_run_id
     and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-archive-download:' || p_run_id || ':' || p_run_attempt,
    0
  ));
  if exists (
    select 1 from private.rv2_archives as prior
     where prior.claimed_run_id = p_run_id
       and prior.claimed_run_attempt = p_run_attempt
  ) then
    raise exception 'archive evidence unavailable' using errcode = 'P0002';
  end if;
  update private.rv2_archives as expired
     set status = 'EXPIRED', download_url = null,
         last_error_code = 'ARCHIVE_URL_EXPIRED',
         completed_at = coalesce(expired.completed_at, statement_timestamp())
   where expired.status in ('PENDING', 'READY')
     and expired.claimed_at is null
     and expired.expires_at <= statement_timestamp();
  update private.rv2_archives as abandoned
     set status = 'FAILED', download_url = null,
         last_error_code = 'ARCHIVE_CLAIM_ABANDONED',
         completed_at = coalesce(abandoned.completed_at, statement_timestamp())
   where abandoned.status = 'CLAIMED'
     and abandoned.claimed_at <= statement_timestamp() - interval '10 minutes';
  select a.* into v_archive
    from private.rv2_archives as a
   where a.status in ('PENDING', 'READY') and a.claimed_at is null
     and a.download_url is not null
     and a.expires_at > statement_timestamp()
     and a.expires_at <= statement_timestamp() + interval '10 minutes'
   order by a.completed_at, a.archive_id
   limit 1 for update skip locked;
  if not found then
    raise exception 'archive evidence unavailable' using errcode = 'P0002';
  end if;
  update private.rv2_archives as a
     set status = 'CLAIMED', claimed_run_id = p_run_id,
         claimed_run_attempt = p_run_attempt, claimed_at = statement_timestamp(),
         download_url = null, last_error_code = null
   where a.archive_id = v_archive.archive_id;
  return query select
    v_archive.archive_id::text, v_archive.archive_sha256, v_archive.bytes,
    v_archive.download_url, v_archive.expires_at;
end
$function$;

create function public.rv2_ops_attest_archive_payload(
  p_run_id text,
  p_run_attempt text,
  p_archive_id text,
  p_archive_sha256 text,
  p_archive_bytes bigint
)
returns table (
  accepted boolean,
  replayed boolean,
  archive_id text,
  archive_sha256 text,
  archive_bytes bigint,
  evidence_source text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_archive record;
  v_archive_uuid uuid;
  v_evidence_source text;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_archive_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_archive_bytes not between 1 and 33554432 then
    raise exception 'archive payload attestation rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-archive'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_archive_uuid := p_archive_id::uuid;
  select a.* into v_archive
    from private.rv2_archives as a
   where a.archive_id = v_archive_uuid
     and a.claimed_run_id = p_run_id
     and a.claimed_run_attempt = p_run_attempt
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_archive.status = 'ATTESTED' then
    if v_archive.archive_sha256 <> p_archive_sha256
       or v_archive.bytes <> p_archive_bytes then
      update private.rv2_archives as a
         set status = 'FAILED', download_url = null,
             last_error_code = 'ARCHIVE_PAYLOAD_MISMATCH',
             completed_at = coalesce(a.completed_at, statement_timestamp())
       where a.archive_id = v_archive_uuid;
      return query select false, false, p_archive_id,
        v_archive.archive_sha256, v_archive.bytes,
        v_archive.payload_evidence_source, 'FAILED'::text;
      return;
    end if;
    return query select true, true, p_archive_id,
      v_archive.archive_sha256, v_archive.bytes,
      v_archive.payload_evidence_source, 'ATTESTED'::text;
    return;
  end if;
  if v_archive.status <> 'CLAIMED'
     or v_archive.claimed_at <= statement_timestamp() - interval '10 minutes' then
    raise exception 'archive payload attestation unavailable' using errcode = '55000';
  end if;
  if (v_archive.archive_sha256 is not null
      and v_archive.archive_sha256 <> p_archive_sha256)
     or (v_archive.bytes is not null and v_archive.bytes <> p_archive_bytes) then
    update private.rv2_archives as a
       set status = 'FAILED', download_url = null,
           last_error_code = 'ARCHIVE_PAYLOAD_MISMATCH',
           completed_at = coalesce(a.completed_at, statement_timestamp())
     where a.archive_id = v_archive_uuid;
    return query select false, false, p_archive_id,
      v_archive.archive_sha256, v_archive.bytes,
      v_archive.payload_evidence_source, 'FAILED'::text;
    return;
  end if;
  v_evidence_source := case
    when v_archive.archive_sha256 is not null then 'UPSTREAM_ATTESTED'
    else 'WORKFLOW_OBSERVED'
  end;
  update private.rv2_archives as a
     set archive_sha256 = p_archive_sha256,
         bytes = p_archive_bytes,
         payload_evidence_source = v_evidence_source,
         status = 'ATTESTED', download_url = null,
         last_error_code = null,
         completed_at = coalesce(a.completed_at, statement_timestamp())
   where a.archive_id = v_archive_uuid;
  return query select true, false, p_archive_id,
    p_archive_sha256, p_archive_bytes, v_evidence_source, 'ATTESTED'::text;
exception when invalid_text_representation then
  raise exception 'archive payload attestation rejected' using errcode = '22023';
end
$function$;

create function public.rv2_ops_fail_archive_claim(
  p_run_id text,
  p_run_attempt text,
  p_archive_id text,
  p_error_code text
)
returns table (
  accepted boolean,
  replayed boolean,
  archive_id text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_archive record;
  v_archive_uuid uuid;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_archive_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_error_code not in (
       'ARCHIVE_DOWNLOAD_FAILED', 'ARCHIVE_PAYLOAD_INVALID',
       'ARCHIVE_PARSE_FAILED', 'ARCHIVE_INGEST_FAILED',
       'ARCHIVE_FINALIZE_FAILED', 'ARCHIVE_WORKFLOW_FAILED'
     ) then
    raise exception 'archive claim failure rejected' using errcode = '22023';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-archive'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_archive_uuid := p_archive_id::uuid;
  select a.* into v_archive
    from private.rv2_archives as a
   where a.archive_id = v_archive_uuid
     and a.claimed_run_id = p_run_id
     and a.claimed_run_attempt = p_run_attempt
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_archive.status = 'FAILED' then
    if v_archive.last_error_code <> p_error_code then
      raise exception 'archive failure replay conflict' using errcode = '40001';
    end if;
    return query select true, true, p_archive_id, 'FAILED'::text;
    return;
  end if;
  if v_archive.status not in ('CLAIMED', 'ATTESTED') then
    raise exception 'archive claim failure unavailable' using errcode = '55000';
  end if;
  update private.rv2_archives as a
     set status = 'FAILED', download_url = null,
         last_error_code = p_error_code,
         completed_at = coalesce(a.completed_at, statement_timestamp())
   where a.archive_id = v_archive_uuid;
  return query select true, false, p_archive_id, 'FAILED'::text;
exception when invalid_text_representation then
  raise exception 'archive claim failure rejected' using errcode = '22023';
end
$function$;

create function public.rv2_ops_ingest_archive_batch(
  p_run_id text,
  p_run_attempt text,
  p_archive_id text,
  p_dataset text,
  p_batch_index integer,
  p_total_batches integer,
  p_source_file text,
  p_records jsonb
)
returns table (
  accepted boolean,
  replayed boolean,
  batch_sha256 text,
  record_count integer,
  total_batches integer,
  source_file text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_archive record;
  v_archive_uuid uuid;
  v_batch_sha256 text;
  v_existing record;
  v_row jsonb;
  v_event_body jsonb;
  v_event_sha256 text;
  v_event_time timestamptz;
  v_row_ordinal integer := 0;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
      or p_archive_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_dataset not in (
       'fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions'
     )
     or p_batch_index < 0 or p_total_batches not between 1 and 100000
     or p_batch_index >= p_total_batches
     or p_source_file <> p_dataset || '.csv'
     or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 250 then
    raise exception 'archive batch rejected' using errcode = '22023';
  end if;
  v_archive_uuid := p_archive_id::uuid;
  select a.* into v_archive from private.rv2_archives as a
   where a.archive_id = v_archive_uuid and a.dataset = p_dataset
     and a.status = 'ATTESTED' and a.claimed_run_id = p_run_id
     and a.claimed_run_attempt = p_run_attempt
   for update;
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  v_batch_sha256 := encode(extensions.digest(convert_to(jsonb_build_object(
    'archiveId', p_archive_id, 'dataset', p_dataset, 'batchIndex', p_batch_index,
    'totalBatches', p_total_batches, 'sourceFile', p_source_file,
    'records', p_records
  )::text, 'utf8'), 'sha256'), 'hex');
  select b.* into v_existing from private.rv2_ops_archive_batches as b
   where b.archive_id = v_archive_uuid and b.dataset = p_dataset
     and b.batch_index = p_batch_index;
  if found then
    if v_existing.batch_sha256 <> v_batch_sha256
       or v_existing.run_id <> p_run_id
       or v_existing.run_attempt <> p_run_attempt
       or v_existing.total_batches <> p_total_batches
       or v_existing.source_file <> p_source_file
       or v_existing.record_count <> jsonb_array_length(p_records) then
      raise exception 'archive batch replay conflict' using errcode = '40001';
    end if;
    return query select true, true, v_existing.batch_sha256,
      v_existing.record_count, v_existing.total_batches, v_existing.source_file;
    return;
  end if;
  if exists (
    select 1 from private.rv2_ops_archive_batches as b
     where b.archive_id = v_archive_uuid and b.dataset = p_dataset
       and (b.run_id <> p_run_id or b.run_attempt <> p_run_attempt
         or b.total_batches <> p_total_batches or b.source_file <> p_source_file)
  ) then
    raise exception 'archive batch set conflict' using errcode = '40001';
  end if;
  -- The staging-row FK is immediate.  Persist the immutable batch header
  -- first, then its rows in the same transaction; any row validation failure
  -- rolls the header back with the function call.
  insert into private.rv2_ops_archive_batches (
    archive_id, run_id, run_attempt, dataset, batch_index, total_batches,
    source_file, batch_sha256, record_count
  ) values (
    v_archive_uuid, p_run_id, p_run_attempt, p_dataset, p_batch_index,
    p_total_batches, p_source_file, v_batch_sha256, jsonb_array_length(p_records)
  );
  for v_row in select value from jsonb_array_elements(p_records) loop
    v_row_ordinal := v_row_ordinal + 1;
    if jsonb_typeof(v_row) <> 'object'
       or (v_row ->> 'providerEventId') !~ '^[A-Za-z0-9_.:@/-]{1,192}$'
       or (v_row ->> 'eventTime') !~ '^[1-9][0-9]{9,15}$' then
      raise exception 'archive batch rejected' using errcode = '22023';
    end if;
    v_event_body := v_row - 'providerEventId' - 'eventTime';
    if jsonb_typeof(v_event_body) <> 'object'
       or octet_length(v_event_body::text) > 65536 then
      raise exception 'archive batch rejected' using errcode = '22023';
    end if;
    v_event_sha256 := encode(extensions.digest(
      convert_to(v_event_body::text, 'utf8'), 'sha256'
    ), 'hex');
    v_event_time := to_timestamp((v_row ->> 'eventTime')::numeric / 1000.0);
    insert into private.rv2_ops_archive_staging_rows (
      archive_id, dataset, provider_event_id, event_time, event_body,
      event_sha256, batch_index, row_ordinal
    ) values (
      v_archive_uuid, p_dataset, v_row ->> 'providerEventId', v_event_time,
      v_event_body, v_event_sha256, p_batch_index, v_row_ordinal
    );
  end loop;
  return query select true, false, v_batch_sha256,
    jsonb_array_length(p_records), p_total_batches, p_source_file;
exception when invalid_text_representation or datetime_field_overflow then
  raise exception 'archive batch rejected' using errcode = '22023';
end
$function$;

create function public.rv2_ops_finalize_archive(
  p_run_id text,
  p_run_attempt text,
  p_archive_id text,
  p_archive_sha256 text,
  p_archive_bytes bigint,
  p_batch_set_sha256 text,
  p_row_count bigint
)
returns table (
  accepted boolean,
  replayed boolean,
  archive_id text,
  status text,
  finalize_sha256 text,
  batch_set_sha256 text,
  source_event_count bigint,
  inserted_count bigint,
  replayed_event_count bigint,
  conflict_count bigint,
  coverage_state text,
  gap_code text,
  trusted_advanced boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_archive record;
  v_job record;
  v_archive_uuid uuid;
  v_total_batches integer;
  v_batch_count bigint;
  v_batch_row_count bigint;
  v_staging_row_count bigint;
  v_computed_batch_set_sha256 text;
  v_finalize_sha256 text;
  v_conflict_count bigint := 0;
  v_inserted_count bigint := 0;
  v_replayed_count bigint := 0;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_gap_end timestamptz;
  v_coverage_state text;
  v_gap_code text;
  v_coverage_evidence jsonb;
begin
  perform private.rv2_require_service_role();
  if p_run_id !~ '^[1-9][0-9]{0,19}$'
     or p_run_attempt !~ '^[1-9][0-9]{0,9}$'
     or p_archive_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_archive_bytes not between 1 and 33554432
     or p_batch_set_sha256 !~ '^[0-9a-f]{64}$'
     or p_row_count not between 0 and 100000 then
    raise exception 'archive finalize rejected' using errcode = '22023';
  end if;
  v_archive_uuid := p_archive_id::uuid;
  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-archive-finalize:' || p_archive_id, 0
  ));
  select a.* into v_archive
    from private.rv2_archives as a
   where a.archive_id = v_archive_uuid
   for update;
  if not found
     or v_archive.claimed_run_id <> p_run_id
     or v_archive.claimed_run_attempt <> p_run_attempt then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  perform 1 from private.rv2_ops_oidc_claims as claim
   where claim.capability = 'beta-archive'
     and claim.run_id = p_run_id and claim.run_attempt = p_run_attempt
     and claim.expires_at > statement_timestamp();
  if not found then
    raise exception 'resource not found' using errcode = 'P0002';
  end if;
  if v_archive.archive_sha256 is distinct from p_archive_sha256
     or v_archive.bytes is distinct from p_archive_bytes then
    raise exception 'archive payload evidence mismatch' using errcode = '40001';
  end if;
  v_finalize_sha256 := encode(extensions.digest(convert_to(jsonb_build_object(
    'archiveId', p_archive_id,
    'archiveSha256', p_archive_sha256,
    'archiveBytes', p_archive_bytes,
    'batchSetSha256', p_batch_set_sha256,
    'rowCount', p_row_count
  )::text, 'utf8'), 'sha256'), 'hex');

  if v_archive.status in ('COMPLETED', 'CONFLICT') then
    if v_archive.finalize_sha256 <> v_finalize_sha256
       or v_archive.batch_set_sha256 <> p_batch_set_sha256
       or v_archive.source_event_count <> p_row_count then
      raise exception 'archive finalize replay conflict' using errcode = '40001';
    end if;
    return query select
      v_archive.status = 'COMPLETED', true, p_archive_id, v_archive.status,
      v_archive.finalize_sha256, v_archive.batch_set_sha256,
      v_archive.source_event_count,
      coalesce((v_archive.coverage_evidence ->> 'insertedCount')::bigint, 0),
      coalesce((v_archive.coverage_evidence ->> 'replayedEventCount')::bigint, 0),
      coalesce((v_archive.coverage_evidence ->> 'conflictCount')::bigint, 0),
      v_archive.coverage_evidence ->> 'state',
      v_archive.coverage_evidence ->> 'gapCode', false;
    return;
  end if;
  if v_archive.status <> 'ATTESTED' then
    raise exception 'archive finalize unavailable' using errcode = '55000';
  end if;
  select j.* into v_job from private.rv2_archive_jobs as j
   where j.tenant_id = v_archive.tenant_id and j.job_id = v_archive.job_id
     and j.connection_id = v_archive.connection_id and j.dataset = v_archive.dataset;
  if not found then
    raise exception 'archive job unavailable' using errcode = '55000';
  end if;
  v_window_start := to_timestamp(v_job.window_start::numeric / 1000.0);
  v_window_end := to_timestamp(v_job.window_end::numeric / 1000.0);
  v_gap_end := greatest(v_window_end, v_window_start + interval '1 millisecond');

  select min(b.total_batches), count(*), coalesce(sum(b.record_count), 0)
    into v_total_batches, v_batch_count, v_batch_row_count
    from private.rv2_ops_archive_batches as b
   where b.archive_id = v_archive_uuid and b.dataset = v_archive.dataset;
  if v_total_batches is null
     or v_batch_count <> v_total_batches
     or v_batch_row_count <> p_row_count
     or exists (
       select expected.batch_index
         from generate_series(0, v_total_batches - 1) as expected(batch_index)
       except
       select b.batch_index from private.rv2_ops_archive_batches as b
        where b.archive_id = v_archive_uuid and b.dataset = v_archive.dataset
     )
     or exists (
       select 1 from private.rv2_ops_archive_batches as b
        where b.archive_id = v_archive_uuid and b.dataset = v_archive.dataset
          and (b.total_batches <> v_total_batches
            or b.run_id <> p_run_id or b.run_attempt <> p_run_attempt
            or b.source_file <> v_archive.dataset || '.csv')
     ) then
    raise exception 'archive batch set incomplete' using errcode = '55000';
  end if;
  if exists (
    select 1
      from private.rv2_ops_archive_batches as b
      left join lateral (
        select count(*)::bigint as row_count
          from private.rv2_ops_archive_staging_rows as s
         where s.archive_id = b.archive_id and s.dataset = b.dataset
           and s.batch_index = b.batch_index
      ) as staged on true
     where b.archive_id = v_archive_uuid and b.dataset = v_archive.dataset
       and staged.row_count <> b.record_count
  ) then
    raise exception 'archive staged row count mismatch' using errcode = '55000';
  end if;
  select count(*) into v_staging_row_count
    from private.rv2_ops_archive_staging_rows as s
   where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset;
  if v_staging_row_count <> p_row_count then
    raise exception 'archive staged row count mismatch' using errcode = '55000';
  end if;
  select encode(extensions.digest(convert_to(string_agg(
    b.dataset || '|' || b.batch_index::text || '|' || b.total_batches::text
      || '|' || b.source_file || '|' || b.batch_sha256 || '|' || b.record_count::text,
    chr(10) order by b.dataset, b.batch_index
  ), 'utf8'), 'sha256'), 'hex')
    into v_computed_batch_set_sha256
    from private.rv2_ops_archive_batches as b
   where b.archive_id = v_archive_uuid and b.dataset = v_archive.dataset;
  if v_computed_batch_set_sha256 <> p_batch_set_sha256 then
    raise exception 'archive batch set digest mismatch' using errcode = '40001';
  end if;

  select count(*) into v_conflict_count from (
    select s.provider_event_id
      from private.rv2_ops_archive_staging_rows as s
     where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset
     group by s.provider_event_id having count(distinct s.event_sha256) > 1
    union
    select s.provider_event_id
      from private.rv2_ops_archive_staging_rows as s
      join public.rv2_source_events as e
        on e.tenant_id = v_archive.tenant_id
       and e.connection_id = v_archive.connection_id
       and e.dataset = v_archive.dataset
       and e.provider_event_id = s.provider_event_id
       and e.event_sha256 <> s.event_sha256
     where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset
  ) as source_event_provider_identity_conflict;

  insert into private.rv2_sync_partitions (
    tenant_id, connection_id, dataset, partition_key, status
  ) values (
    v_archive.tenant_id, v_archive.connection_id, v_archive.dataset,
    v_archive.partition_key, 'ACTIVE'
  ) on conflict (tenant_id, connection_id, dataset, partition_key) do nothing;
  insert into private.rv2_sync_coverage (
    tenant_id, connection_id, dataset, partition_key, state,
    attempted_through, fetched_through, committed_through, trusted_through,
    updated_by_job_id, updated_at
  ) values (
    v_archive.tenant_id, v_archive.connection_id, v_archive.dataset,
    v_archive.partition_key, case when v_conflict_count > 0 then 'CONFLICT' else 'PARTIAL' end,
    v_window_end, v_window_end, case when v_conflict_count = 0 then v_window_end else null end,
    null, v_archive.job_id, statement_timestamp()
  ) on conflict (tenant_id, connection_id, dataset, partition_key) do update
    set state = case when v_conflict_count > 0 then 'CONFLICT' else 'PARTIAL' end,
        attempted_through = greatest(private.rv2_sync_coverage.attempted_through, excluded.attempted_through),
        fetched_through = greatest(private.rv2_sync_coverage.fetched_through, excluded.fetched_through),
        committed_through = case when v_conflict_count > 0
          then private.rv2_sync_coverage.committed_through
          else greatest(private.rv2_sync_coverage.committed_through, excluded.committed_through) end,
        trusted_through = private.rv2_sync_coverage.trusted_through,
        updated_by_job_id = excluded.updated_by_job_id,
        updated_at = statement_timestamp();

  if v_conflict_count > 0 then
    with intra as (
      select s.provider_event_id, min(s.event_sha256) as existing_sha256,
             max(s.event_sha256) as observed_sha256
        from private.rv2_ops_archive_staging_rows as s
       where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset
       group by s.provider_event_id having count(distinct s.event_sha256) > 1
    )
    insert into private.rv2_source_event_conflicts (
      tenant_id, connection_id, dataset, provider_event_id,
      existing_sha256, observed_sha256, first_job_id, last_job_id
    )
    select v_archive.tenant_id, v_archive.connection_id, v_archive.dataset,
           intra.provider_event_id, intra.existing_sha256, intra.observed_sha256,
           v_archive.job_id, v_archive.job_id
      from intra
    on conflict (tenant_id, connection_id, dataset, provider_event_id) do update
      set observed_sha256 = excluded.observed_sha256,
          last_job_id = excluded.last_job_id,
          occurrences = private.rv2_source_event_conflicts.occurrences + 1,
          last_seen_at = statement_timestamp(), status = 'OPEN', resolved_at = null;

    with upstream as (
      select distinct on (s.provider_event_id)
             s.provider_event_id, e.event_sha256 as existing_sha256,
             s.event_sha256 as observed_sha256
        from private.rv2_ops_archive_staging_rows as s
        join public.rv2_source_events as e
          on e.tenant_id = v_archive.tenant_id
         and e.connection_id = v_archive.connection_id
         and e.dataset = v_archive.dataset
         and e.provider_event_id = s.provider_event_id
         and e.event_sha256 <> s.event_sha256
       where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset
       order by s.provider_event_id, s.event_sha256
    )
    insert into private.rv2_source_event_conflicts (
      tenant_id, connection_id, dataset, provider_event_id,
      existing_sha256, observed_sha256, first_job_id, last_job_id
    )
    select v_archive.tenant_id, v_archive.connection_id, v_archive.dataset,
           upstream.provider_event_id, upstream.existing_sha256, upstream.observed_sha256,
           v_archive.job_id, v_archive.job_id
      from upstream
    on conflict (tenant_id, connection_id, dataset, provider_event_id) do update
      set observed_sha256 = excluded.observed_sha256,
          last_job_id = excluded.last_job_id,
          occurrences = private.rv2_source_event_conflicts.occurrences + 1,
          last_seen_at = statement_timestamp(), status = 'OPEN', resolved_at = null;

    v_coverage_state := 'CONFLICT';
    v_gap_code := 'ARCHIVE_PROVIDER_IDENTITY_CONFLICT';
    v_inserted_count := 0;
    v_replayed_count := 0;
  else
    with candidates as (
      select distinct on (s.provider_event_id)
             s.provider_event_id, s.event_time, s.event_body, s.event_sha256
        from private.rv2_ops_archive_staging_rows as s
       where s.archive_id = v_archive_uuid and s.dataset = v_archive.dataset
       order by s.provider_event_id, s.batch_index, s.row_ordinal
    ), inserted as (
      insert into public.rv2_source_events (
        tenant_id, connection_id, sync_job_id, dataset,
        provider_event_id, event_time, event_body, event_sha256
      )
      select v_archive.tenant_id, v_archive.connection_id, v_archive.job_id,
             v_archive.dataset, c.provider_event_id, c.event_time,
             c.event_body, c.event_sha256
        from candidates as c
       where not exists (
         select 1 from public.rv2_source_events as e
          where e.tenant_id = v_archive.tenant_id
            and e.connection_id = v_archive.connection_id
            and e.dataset = v_archive.dataset
            and e.provider_event_id = c.provider_event_id
       )
      returning event_id
    ) select count(*) into v_inserted_count from inserted;
    v_replayed_count := p_row_count - v_inserted_count;
    v_coverage_state := 'PARTIAL';
    v_gap_code := 'ARCHIVE_RECONCILIATION_PENDING';
  end if;

  insert into private.rv2_sync_gaps (
    tenant_id, connection_id, dataset, partition_key, gap_code,
    gap_start, gap_end, status, detected_by_job_id
  )
  select v_archive.tenant_id, v_archive.connection_id, v_archive.dataset,
         v_archive.partition_key, v_gap_code, v_window_start, v_gap_end,
         'OPEN', v_archive.job_id
   where not exists (
     select 1 from private.rv2_sync_gaps as g
      where g.tenant_id = v_archive.tenant_id
        and g.connection_id = v_archive.connection_id
        and g.dataset = v_archive.dataset and g.partition_key = v_archive.partition_key
        and g.gap_code = v_gap_code and g.status = 'OPEN'
   );
  v_coverage_evidence := jsonb_build_object(
    'protocol', 'rv-archive-coverage/1',
    'state', v_coverage_state,
    'partition', v_archive.partition_key,
    'attemptedThrough', v_window_end,
    'fetchedThrough', v_window_end,
    'committedThrough', case when v_conflict_count = 0 then v_window_end else null end,
    'trustedThrough', null,
    'gapCode', v_gap_code,
    'sourceEventCount', p_row_count,
    'payloadEvidenceSource', v_archive.payload_evidence_source,
    'insertedCount', v_inserted_count,
    'replayedEventCount', v_replayed_count,
    'conflictCount', v_conflict_count,
    'trustedAdvanced', false
  );
  update private.rv2_archives as a
     set archive_sha256 = p_archive_sha256, bytes = p_archive_bytes,
         finalize_sha256 = v_finalize_sha256,
         batch_set_sha256 = p_batch_set_sha256,
         source_event_count = p_row_count,
         coverage_evidence = v_coverage_evidence,
         finalized_at = statement_timestamp(),
         completed_at = coalesce(a.completed_at, statement_timestamp()),
         status = case when v_conflict_count > 0 then 'CONFLICT' else 'COMPLETED' end
   where a.archive_id = v_archive_uuid;
  update private.rv2_archive_jobs as j
     set archive_state = jsonb_build_object(
           'protocol', 'rv-archive-finalize/1',
           'status', case when v_conflict_count > 0 then 'CONFLICT' else 'COMPLETED' end,
           'archiveId', p_archive_id,
           'rowCount', p_row_count,
           'conflictCount', v_conflict_count,
           'coverageState', v_coverage_state
         ),
         status = 'STAGED', completed_at = coalesce(j.completed_at, statement_timestamp()),
         claim_token = null, lease_expires_at = null, updated_at = statement_timestamp()
   where j.tenant_id = v_archive.tenant_id and j.job_id = v_archive.job_id;
  return query select
    v_conflict_count = 0, false, p_archive_id,
    case when v_conflict_count > 0 then 'CONFLICT' else 'COMPLETED' end,
    v_finalize_sha256, p_batch_set_sha256, p_row_count,
    v_inserted_count, v_replayed_count, v_conflict_count,
    v_coverage_state, v_gap_code, false;
exception when invalid_text_representation or datetime_field_overflow then
  raise exception 'archive finalize rejected' using errcode = '22023';
end
$function$;

create function private.rv2_run_invite_beta_scheduler()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  perform public.rv2_service_enqueue_due_syncs(
    '00000000-0000-4000-8000-000000000002'::uuid,
    10
  );
end
$function$;

create function private.rv2_wake_invite_beta_worker()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_edge_origin text;
  v_worker_token text;
begin
  select s.decrypted_secret into v_edge_origin
    from vault.decrypted_secrets as s
   where s.name = 'rv2_edge_origin'
   limit 1;
  select s.decrypted_secret into v_worker_token
    from vault.decrypted_secrets as s
   where s.name = 'rv2_worker_cron_token'
   limit 1;
  if v_edge_origin !~ '^https://[a-z0-9]{20}\.supabase\.co$'
     or v_worker_token !~ '^[A-Za-z0-9_-]{64}$' then
    return;
  end if;
  perform net.http_post(
    url := v_edge_origin || '/functions/v1/binance-beta/internal/v1/sync/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-rv-worker-token', v_worker_token
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 10000
  );
end
$function$;

create function private.rv2_wake_invite_beta_archive_worker()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_edge_origin text;
  v_archive_token text;
begin
  select s.decrypted_secret into v_edge_origin
    from vault.decrypted_secrets as s
   where s.name = 'rv2_edge_origin'
   limit 1;
  select s.decrypted_secret into v_archive_token
    from vault.decrypted_secrets as s
   where s.name = 'rv2_archive_cron_token'
   limit 1;
  if v_edge_origin !~ '^https://[a-z0-9]{20}\.supabase\.co$'
     or v_archive_token !~ '^[A-Za-z0-9_-]{64}$' then
    return;
  end if;
  perform net.http_post(
    url := v_edge_origin || '/functions/v1/binance-beta/internal/v1/archive/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-rv-worker-token', v_archive_token
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 10000
  );
end
$function$;

alter function private.rv2_run_invite_beta_scheduler() owner to postgres;
alter function private.rv2_wake_invite_beta_worker() owner to postgres;
alter function private.rv2_wake_invite_beta_archive_worker() owner to postgres;
revoke all on function private.rv2_run_invite_beta_scheduler()
from public, anon, authenticated, service_role;
revoke all on function private.rv2_wake_invite_beta_worker()
from public, anon, authenticated, service_role;
revoke all on function private.rv2_wake_invite_beta_archive_worker()
from public, anon, authenticated, service_role;
grant execute on function private.rv2_run_invite_beta_scheduler() to postgres;
grant execute on function private.rv2_wake_invite_beta_worker() to postgres;
grant execute on function private.rv2_wake_invite_beta_archive_worker() to postgres;

select cron.schedule(
  'rv2-enqueue-due-syncs',
  '*/10 * * * *',
  $cron$select private.rv2_run_invite_beta_scheduler();$cron$
);

select cron.schedule(
  'rv2-wake-beta-worker',
  '* * * * *',
  $cron$select private.rv2_wake_invite_beta_worker();$cron$
);

select cron.schedule(
  'rv2-wake-beta-archive-worker',
  '*/10 * * * *',
  $cron$select private.rv2_wake_invite_beta_archive_worker();$cron$
);

-- All rv2 relations are RPC-only. Forced RLS remains a second fail-closed
-- boundary if a future grant accidentally reaches the Data API.
alter table public.rv2_tenants enable row level security;
alter table public.rv2_tenants force row level security;
alter table public.rv2_memberships enable row level security;
alter table public.rv2_memberships force row level security;
alter table public.rv2_connections enable row level security;
alter table public.rv2_connections force row level security;
alter table public.rv2_source_events enable row level security;
alter table public.rv2_source_events force row level security;
alter table public.rv2_generations enable row level security;
alter table public.rv2_generations force row level security;
alter table public.rv2_trade_identities enable row level security;
alter table public.rv2_trade_identities force row level security;
alter table public.rv2_trade_read_models enable row level security;
alter table public.rv2_trade_read_models force row level security;
alter table public.rv2_reviews enable row level security;
alter table public.rv2_reviews force row level security;
alter table public.rv2_actions enable row level security;
alter table public.rv2_actions force row level security;
alter table public.rv2_journal_entries enable row level security;
alter table public.rv2_journal_entries force row level security;
alter table public.rv2_risk_rules enable row level security;
alter table public.rv2_risk_rules force row level security;
alter table public.rv2_reports enable row level security;
alter table public.rv2_reports force row level security;
alter table public.rv2_ledger_generations enable row level security;
alter table public.rv2_ledger_generations force row level security;
alter table public.rv2_reconciliation_generations enable row level security;
alter table public.rv2_reconciliation_generations force row level security;

alter table private.rv2_credential_envelopes enable row level security;
alter table private.rv2_credential_envelopes force row level security;
alter table private.rv2_sync_jobs enable row level security;
alter table private.rv2_sync_jobs force row level security;
alter table private.rv2_sync_attempts enable row level security;
alter table private.rv2_sync_attempts force row level security;
alter table private.rv2_sync_partitions enable row level security;
alter table private.rv2_sync_partitions force row level security;
alter table private.rv2_sync_coverage enable row level security;
alter table private.rv2_sync_coverage force row level security;
alter table private.rv2_sync_gaps enable row level security;
alter table private.rv2_sync_gaps force row level security;
alter table private.rv2_archive_jobs enable row level security;
alter table private.rv2_archive_jobs force row level security;
alter table private.rv2_archives enable row level security;
alter table private.rv2_archives force row level security;
alter table private.rv2_egress_receipts enable row level security;
alter table private.rv2_egress_receipts force row level security;
alter table private.rv2_backup_runs enable row level security;
alter table private.rv2_backup_runs force row level security;
alter table private.rv2_review_requests enable row level security;
alter table private.rv2_review_requests force row level security;
alter table private.rv2_domain_mutation_requests enable row level security;
alter table private.rv2_domain_mutation_requests force row level security;
alter table private.rv2_trade_projection_evidence enable row level security;
alter table private.rv2_trade_projection_evidence force row level security;
alter table private.rv2_source_event_conflicts enable row level security;
alter table private.rv2_source_event_conflicts force row level security;
alter table private.rv2_ledger_shadow_submissions enable row level security;
alter table private.rv2_ledger_shadow_submissions force row level security;
alter table private.rv2_post_commit_work enable row level security;
alter table private.rv2_post_commit_work force row level security;
alter table private.rv2_ops_oidc_claims enable row level security;
alter table private.rv2_ops_oidc_claims force row level security;
alter table private.rv2_ops_backup_snapshots enable row level security;
alter table private.rv2_ops_backup_snapshots force row level security;
alter table private.rv2_ops_backup_snapshot_rows enable row level security;
alter table private.rv2_ops_backup_snapshot_rows force row level security;
alter table private.rv2_ops_backup_page_evidence enable row level security;
alter table private.rv2_ops_backup_page_evidence force row level security;
alter table private.rv2_ops_backup_signing_claims enable row level security;
alter table private.rv2_ops_backup_signing_claims force row level security;
alter table private.rv2_ops_restore_runs enable row level security;
alter table private.rv2_ops_restore_runs force row level security;
alter table private.rv2_ops_restore_batches enable row level security;
alter table private.rv2_ops_restore_batches force row level security;
alter table private.rv2_ops_restore_staging_rows enable row level security;
alter table private.rv2_ops_restore_staging_rows force row level security;
alter table private.rv2_ops_archive_batches enable row level security;
alter table private.rv2_ops_archive_batches force row level security;
alter table private.rv2_ops_archive_staging_rows enable row level security;
alter table private.rv2_ops_archive_staging_rows force row level security;
alter table private.rv2_deletion_tombstones enable row level security;
alter table private.rv2_deletion_tombstones force row level security;
alter table private.rv2_worker_control enable row level security;
alter table private.rv2_worker_control force row level security;

revoke all privileges on table public.rv2_tenants from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_memberships from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_connections from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_source_events from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_generations from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_trade_identities from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_trade_read_models from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_reviews from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_actions from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_journal_entries from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_risk_rules from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_reports from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_ledger_generations from public, anon, authenticated, service_role;
revoke all privileges on table public.rv2_reconciliation_generations from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_credential_envelopes from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_sync_jobs from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_sync_attempts from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_sync_partitions from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_sync_coverage from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_sync_gaps from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_archive_jobs from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_archives from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_egress_receipts from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_backup_runs from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_review_requests from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_domain_mutation_requests from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_trade_projection_evidence from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_source_event_conflicts from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ledger_shadow_submissions from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_post_commit_work from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_oidc_claims from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_backup_snapshots from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_backup_snapshot_rows from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_backup_page_evidence from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_backup_signing_claims from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_restore_runs from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_restore_batches from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_restore_staging_rows from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_archive_batches from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_ops_archive_staging_rows from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_deletion_tombstones from public, anon, authenticated, service_role;
revoke all privileges on table private.rv2_worker_control from public, anon, authenticated, service_role;

revoke all on function private.rv2_permission_evidence_is_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_enforce_personal_membership_identity() from public, anon, authenticated, service_role;
revoke all on function private.rv2_enforce_tenant_limits() from public, anon, authenticated, service_role;
revoke all on function private.rv2_reject_source_event_update() from public, anon, authenticated, service_role;
revoke all on function private.rv2_enforce_generation_state_transition() from public, anon, authenticated, service_role;
revoke all on function private.rv2_require_browser_tenant() from public, anon, authenticated, service_role;
revoke all on function private.rv2_require_service_membership(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rv2_execution_row_is_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_reason_codes_are_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_reconciliation_is_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_capabilities_are_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.rv2_dataset_coverage_document(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.rv2_coverage_document(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rv2_default_reconciliation() from public, anon, authenticated, service_role;
revoke all on function private.rv2_default_capabilities() from public, anon, authenticated, service_role;
revoke all on function private.rv2_payload_has_credential_key(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function private.rv2_canonical_trade_decimal(numeric) from public, anon, authenticated, service_role;
revoke all on function private.rv2_project_trade_read_models(uuid, uuid, bigint, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.rv2_clear_subject_business_data(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rv2_require_service_role() from public, anon, authenticated, service_role;
revoke all on function private.rv2_ops_materialize_backup_snapshot(text, timestamptz, bigint) from public, anon, authenticated, service_role;

revoke all on function public.rv2_get_tenant_context() from public, anon, authenticated, service_role;
revoke all on function public.rv2_enqueue_sync(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_list_connections() from public, anon, authenticated, service_role;
revoke all on function public.rv2_get_dataset_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_get_current_dataset(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_get_trades(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_get_reviews(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_upsert_review(uuid, text, bigint, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_upsert_action(uuid, uuid, uuid, text, text, bigint, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_upsert_journal(uuid, date, bigint, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_upsert_risk_rule(uuid, uuid, text, bigint, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_upsert_report(uuid, text, date, date, bigint, bigint, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_disconnect_connection(uuid, bigint) from public, anon, authenticated, service_role;

grant execute on function public.rv2_get_tenant_context() to authenticated;
grant execute on function public.rv2_enqueue_sync(uuid, text, text, uuid) to authenticated;
grant execute on function public.rv2_list_connections() to authenticated;
grant execute on function public.rv2_get_dataset_status(uuid) to authenticated;
grant execute on function public.rv2_get_current_dataset(uuid) to authenticated;
grant execute on function public.rv2_get_trades(uuid) to authenticated;
grant execute on function public.rv2_get_reviews(uuid) to authenticated;
grant execute on function public.rv2_upsert_review(uuid, text, bigint, uuid, jsonb) to authenticated;
grant execute on function public.rv2_upsert_action(uuid, uuid, uuid, text, text, bigint, uuid, jsonb) to authenticated;
grant execute on function public.rv2_upsert_journal(uuid, date, bigint, uuid, jsonb) to authenticated;
grant execute on function public.rv2_upsert_risk_rule(uuid, uuid, text, bigint, uuid, jsonb) to authenticated;
grant execute on function public.rv2_upsert_report(uuid, text, date, date, bigint, bigint, uuid, jsonb) to authenticated;
grant execute on function public.rv2_disconnect_connection(uuid, bigint) to authenticated;

revoke all on function public.rv2_service_provision_tenant(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_create_or_rotate_connection(uuid, uuid, uuid, text, text, text, jsonb, text, text, text, text, text, bigint, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_enqueue_due_syncs(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_claim_sync_job(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_renew_sync_job(uuid, uuid, uuid, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_commit_sync_page(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb, boolean, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_schedule_discovered_symbols(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_submit_ledger_shadow(uuid, uuid, uuid, bigint, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_claim_post_commit_work(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_complete_post_commit_work(uuid, uuid, uuid, bigint, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_fail_post_commit_work(uuid, uuid, uuid, bigint, uuid, uuid, text, text, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_open_worker_circuit(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_fail_sync_job(uuid, uuid, uuid, bigint, text, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_claim_archive_job(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_commit_archive_state(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_fail_archive_job(uuid, uuid, uuid, bigint, text, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_stage_archive_link(uuid, uuid, uuid, bigint, text, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_publish_generation(uuid, uuid, bigint, bigint, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.rv2_service_delete_tenant_data(uuid, uuid, bigint) from public, anon, authenticated, service_role;

grant execute on function public.rv2_service_provision_tenant(uuid) to service_role;
grant execute on function public.rv2_service_create_or_rotate_connection(uuid, uuid, uuid, text, text, text, jsonb, text, text, text, text, text, bigint, uuid, text) to service_role;
grant execute on function public.rv2_service_enqueue_due_syncs(uuid, integer) to service_role;
grant execute on function public.rv2_service_claim_sync_job(uuid, uuid, text, integer) to service_role;
grant execute on function public.rv2_service_renew_sync_job(uuid, uuid, uuid, bigint, integer) to service_role;
grant execute on function public.rv2_service_commit_sync_page(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb, boolean, text, jsonb) to service_role;
grant execute on function public.rv2_service_schedule_discovered_symbols(uuid, uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.rv2_service_submit_ledger_shadow(uuid, uuid, uuid, bigint, jsonb, jsonb, text) to service_role;
grant execute on function public.rv2_service_claim_post_commit_work(uuid, uuid, integer) to service_role;
grant execute on function public.rv2_service_complete_post_commit_work(uuid, uuid, uuid, bigint, uuid, uuid, text) to service_role;
grant execute on function public.rv2_service_fail_post_commit_work(uuid, uuid, uuid, bigint, uuid, uuid, text, text, boolean, integer) to service_role;
grant execute on function public.rv2_service_open_worker_circuit(uuid, text, integer) to service_role;
grant execute on function public.rv2_service_fail_sync_job(uuid, uuid, uuid, bigint, text, boolean, integer) to service_role;
grant execute on function public.rv2_service_claim_archive_job(uuid, uuid, integer) to service_role;
grant execute on function public.rv2_service_commit_archive_state(uuid, uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.rv2_service_fail_archive_job(uuid, uuid, uuid, bigint, text, boolean, integer) to service_role;
grant execute on function public.rv2_service_stage_archive_link(uuid, uuid, uuid, bigint, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.rv2_service_publish_generation(uuid, uuid, bigint, bigint, uuid[]) to service_role;
grant execute on function public.rv2_service_delete_tenant_data(uuid, uuid, bigint) to service_role;

revoke all on function public.rv2_ops_claim_oidc_jti(text, text, timestamptz, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_read_backup_page(text, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_record_backup_page_evidence(text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_claim_backup_signing_evidence(text, text, text, text, text, bigint, jsonb, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_apply_deletion_tombstones(text, bigint, bigint, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_claim_restore_manifest(text, bigint, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_claim_archive_download(text, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_attest_archive_payload(text, text, text, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_fail_archive_claim(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_ingest_archive_batch(text, text, text, text, integer, integer, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rv2_ops_finalize_archive(text, text, text, text, bigint, text, bigint) from public, anon, authenticated, service_role;

grant execute on function public.rv2_ops_claim_oidc_jti(text, text, timestamptz, jsonb) to service_role;
grant execute on function public.rv2_ops_read_backup_page(text, text, text, integer, text) to service_role;
grant execute on function public.rv2_ops_record_backup_page_evidence(text, text, text, text, jsonb) to service_role;
grant execute on function public.rv2_ops_claim_backup_signing_evidence(text, text, text, text, text, bigint, jsonb, text, bigint, text) to service_role;
grant execute on function public.rv2_ops_apply_deletion_tombstones(text, bigint, bigint, text, timestamptz) to service_role;
grant execute on function public.rv2_ops_claim_restore_manifest(text, bigint, text, text, text, text, text, text) to service_role;
grant execute on function public.rv2_ops_claim_archive_download(text, text) to service_role;
grant execute on function public.rv2_ops_attest_archive_payload(text, text, text, text, bigint) to service_role;
grant execute on function public.rv2_ops_fail_archive_claim(text, text, text, text) to service_role;
grant execute on function public.rv2_ops_ingest_archive_batch(text, text, text, text, integer, integer, text, jsonb) to service_role;
grant execute on function public.rv2_ops_finalize_archive(text, text, text, text, bigint, text, bigint) to service_role;

-- The parallel rv2 plane makes the legacy browser vault read-only. Existing
-- authenticated read RPCs and all destructive-operation recovery RPCs keep
-- their prior grants and behavior.
revoke execute on function public.rv_bootstrap_workspace(uuid, text, text, text, uuid) from authenticated;
revoke execute on function public.rv_register_device(uuid, uuid, text, uuid) from authenticated;
revoke execute on function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) from authenticated;

comment on table private.rv2_credential_envelopes is
  'RPC-only credential envelopes; never exposed through direct Data API grants.';
comment on table private.rv2_sync_attempts is
  'PII-free bounded state and error codes only; no upstream response or stack text.';
comment on function public.rv2_service_claim_sync_job(uuid, uuid, text, integer) is
  'Global bounded claim derives tenant and enqueue subject from the locked job; it accepts no tenant or user body field.';

commit;

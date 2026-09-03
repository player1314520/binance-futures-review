begin;

-- Supabase Free does not provide a trusted inbound client-IP limiter or a
-- configurable whole-project Edge concurrency ceiling. Enforce the controls
-- that can be proved at the database boundary instead: identity-bound token
-- buckets and a ten-slot transaction semaphore. No raw user, session, or
-- recovery-capability identifier is retained in the limiter table.
create table private.rv_rate_limit_buckets (
  scope text not null,
  identity_kind text not null,
  identity_fingerprint text not null,
  available_tokens numeric(18, 6) not null,
  refilled_at timestamptz not null,
  expires_at timestamptz not null,
  constraint rv_rate_limit_buckets_pkey
    primary key (scope, identity_kind, identity_fingerprint),
  constraint rv_rate_limit_buckets_scope_check
    check (scope in ('vault', 'destructive', 'deletion-status', 'deletion-status-global')),
  constraint rv_rate_limit_buckets_identity_kind_check
    check (identity_kind in ('subject', 'session', 'capability', 'global')),
  constraint rv_rate_limit_buckets_identity_fingerprint_check
    check (identity_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint rv_rate_limit_buckets_available_tokens_check
    check (available_tokens >= 0),
  constraint rv_rate_limit_buckets_expiry_check
    check (expires_at > refilled_at)
);

alter table private.rv_rate_limit_buckets enable row level security;
alter table private.rv_rate_limit_buckets force row level security;

create index rv_rate_limit_buckets_expires_at_idx
  on private.rv_rate_limit_buckets (expires_at);

comment on table private.rv_rate_limit_buckets is
  'Short-lived token buckets keyed only by domain-separated SHA-256 fingerprints; never stores raw subject, session, capability, email, or IP values.';

create function private.rv_rate_limit_fingerprint(
  p_domain text,
  p_value text
)
returns text
language sql
immutable
strict
security definer
set search_path = pg_catalog
as $function$
  select encode(
    extensions.digest(
      convert_to('review-workbench-admission-v1' || chr(0) || p_domain || chr(0) || p_value, 'utf8'),
      'sha256'
    ),
    'hex'
  );
$function$;

create function private.rv_consume_rate_limit(
  p_scope text,
  p_identity_kind text,
  p_identity_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_capacity integer;
  v_refill_per_second numeric(18, 9);
  v_now timestamptz := statement_timestamp();
  v_inserted bigint := 0;
  v_row private.rv_rate_limit_buckets%rowtype;
  v_available numeric(18, 6);
  v_elapsed_seconds numeric(18, 6);
begin
  if p_identity_fingerprint is null
     or p_identity_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'admission identity rejected' using errcode = '22023';
  end if;

  if p_scope = 'vault' and p_identity_kind in ('subject', 'session') then
    v_capacity := 120;
    v_refill_per_second := 2;
  elsif p_scope = 'destructive' and p_identity_kind in ('subject', 'session') then
    v_capacity := 10;
    v_refill_per_second := 10::numeric / 60::numeric;
  elsif p_scope = 'deletion-status' and p_identity_kind = 'capability' then
    v_capacity := 10;
    v_refill_per_second := 10::numeric / 60::numeric;
  elsif p_scope = 'deletion-status-global' and p_identity_kind = 'global' then
    v_capacity := 60;
    v_refill_per_second := 1;
  else
    raise exception 'unknown admission policy' using errcode = '22023';
  end if;

  insert into private.rv_rate_limit_buckets (
    scope, identity_kind, identity_fingerprint,
    available_tokens, refilled_at, expires_at
  ) values (
    p_scope, p_identity_kind, p_identity_fingerprint,
    v_capacity - 1, v_now, v_now + interval '10 minutes'
  ) on conflict (scope, identity_kind, identity_fingerprint) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return;
  end if;

  select b.* into v_row
    from private.rv_rate_limit_buckets as b
   where b.scope = p_scope
     and b.identity_kind = p_identity_kind
     and b.identity_fingerprint = p_identity_fingerprint
   for update;

  v_elapsed_seconds := greatest(
    extract(epoch from (v_now - v_row.refilled_at))::numeric,
    0::numeric
  );
  v_available := least(
    v_capacity::numeric,
    v_row.available_tokens + (v_elapsed_seconds * v_refill_per_second)
  );
  if v_available < 1 then
    raise exception 'rate limit exceeded' using errcode = 'P0004';
  end if;

  update private.rv_rate_limit_buckets as b
     set available_tokens = v_available - 1,
         refilled_at = v_now,
         expires_at = v_now + interval '10 minutes'
   where b.scope = p_scope
     and b.identity_kind = p_identity_kind
     and b.identity_fingerprint = p_identity_fingerprint;
end
$function$;

create function private.rv_consume_subject_session_limit(
  p_scope text,
  p_subject uuid,
  p_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if p_subject is null or p_session_id is null then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
  perform private.rv_consume_rate_limit(
    p_scope,
    'subject',
    private.rv_rate_limit_fingerprint(p_scope || '-subject', p_subject::text)
  );
  perform private.rv_consume_rate_limit(
    p_scope,
    'session',
    private.rv_rate_limit_fingerprint(p_scope || '-session', p_session_id::text)
  );
end
$function$;

create function private.rv_acquire_user_database_slot()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_slot integer;
begin
  for v_slot in 0..9 loop
    if pg_try_advisory_xact_lock(187904819, v_slot) then
      return;
    end if;
  end loop;
  raise exception 'database capacity temporarily unavailable' using errcode = 'P0005';
end
$function$;

create function private.rv_prune_rate_limit_buckets()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_changed bigint := 0;
begin
  with expired as (
    select b.scope, b.identity_kind, b.identity_fingerprint
      from private.rv_rate_limit_buckets as b
     where b.expires_at <= statement_timestamp()
     order by b.expires_at, b.scope, b.identity_kind, b.identity_fingerprint
     limit 500
     for update skip locked
  )
  delete from private.rv_rate_limit_buckets as doomed
   using expired
   where doomed.scope = expired.scope
     and doomed.identity_kind = expired.identity_kind
     and doomed.identity_fingerprint = expired.identity_fingerprint;
  get diagnostics v_changed = row_count;
  return v_changed;
end
$function$;

-- Preserve the reviewed implementations as private cores and put all public
-- entry points behind admission wrappers. The move is transactional, so no
-- caller can observe a missing public function.
alter function public.rv_bootstrap_workspace(uuid, text, text, text, uuid) set schema private;
alter function private.rv_bootstrap_workspace(uuid, text, text, text, uuid) rename to rv_core_bootstrap_workspace;
alter function public.rv_register_device(uuid, uuid, text, uuid) set schema private;
alter function private.rv_register_device(uuid, uuid, text, uuid) rename to rv_core_register_device;
alter function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) set schema private;
alter function private.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) rename to rv_core_upload_vault_generation;
alter function public.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid) set schema private;
alter function private.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid) rename to rv_core_service_publish_vault_head;
alter function public.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text) set schema private;
alter function private.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text) rename to rv_core_service_execute_workspace_deletion;
alter function public.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text) set schema private;
alter function private.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text) rename to rv_core_service_execute_business_deletion;
alter function public.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz) set schema private;
alter function private.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz) rename to rv_core_begin_destructive_operation;
alter function public.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text) set schema private;
alter function private.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text) rename to rv_core_mark_destructive_operation_deleting;
alter function public.rv_mark_destructive_operation_completed(uuid, text, text, text, text) set schema private;
alter function private.rv_mark_destructive_operation_completed(uuid, text, text, text, text) rename to rv_core_mark_destructive_operation_completed;
alter function public.rv_get_destructive_operation_status(uuid, text, text, text, text) set schema private;
alter function private.rv_get_destructive_operation_status(uuid, text, text, text, text) rename to rv_core_get_destructive_operation_status;

create function public.rv_bootstrap_workspace(
  p_workspace_id uuid,
  p_signing_algorithm text,
  p_signing_public_key text,
  p_write_capability text,
  p_session_id uuid
)
returns table (
  workspace_id uuid,
  signing_algorithm text,
  signing_public_key text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_bootstrap_workspace(
    p_workspace_id, p_signing_algorithm, p_signing_public_key,
    p_write_capability, p_session_id
  );
end
$function$;

create function public.rv_register_device(
  p_workspace_id uuid,
  p_device_id uuid,
  p_write_capability text,
  p_session_id uuid
)
returns table (
  workspace_id uuid,
  device_id uuid,
  created_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_register_device(
    p_workspace_id, p_device_id, p_write_capability, p_session_id
  );
end
$function$;

create function public.rv_upload_vault_generation(
  p_workspace_id uuid,
  p_device_id uuid,
  p_object_id uuid,
  p_generation bigint,
  p_envelope_version smallint,
  p_ciphertext text,
  p_ciphertext_sha256 text,
  p_signature text,
  p_parent_object_id uuid,
  p_parent_ciphertext_sha256 text,
  p_write_capability text,
  p_session_id uuid
)
returns table (
  workspace_id uuid,
  object_id uuid,
  generation bigint,
  envelope_version smallint,
  ciphertext_sha256 text,
  signature text,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  created_by_device_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_upload_vault_generation(
    p_workspace_id, p_device_id, p_object_id, p_generation,
    p_envelope_version, p_ciphertext, p_ciphertext_sha256, p_signature,
    p_parent_object_id, p_parent_ciphertext_sha256, p_write_capability,
    p_session_id
  );
end
$function$;

create function public.rv_list_workspaces(
  p_session_id uuid,
  p_limit integer default 100
)
returns table (
  workspace_id uuid,
  signing_algorithm text,
  signing_public_key text,
  created_at timestamptz,
  head_object_id uuid,
  head_generation bigint,
  head_updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid workspace limit' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query
    select w.workspace_id, w.signing_algorithm, w.signing_public_key, w.created_at,
           h.object_id, h.generation, h.updated_at
      from public.workspaces as w
      left join public.vault_heads as h
        on h.user_id = w.user_id
       and h.workspace_id = w.workspace_id
     where w.user_id = v_subject
     order by w.created_at desc, w.workspace_id
     limit p_limit;
end
$function$;

create function public.rv_read_generation_object(
  p_session_id uuid,
  p_workspace_id uuid,
  p_object_id uuid
)
returns table (
  workspace_id uuid,
  object_id uuid,
  generation bigint,
  envelope_version smallint,
  ciphertext_sha256 text,
  signature text,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  created_by_device_id uuid,
  created_at timestamptz,
  ciphertext text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  if p_workspace_id is null or p_object_id is null then
    raise exception 'invalid vault object request' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query
    select o.workspace_id, o.object_id, o.generation, o.envelope_version,
           o.ciphertext_sha256, o.signature, o.parent_object_id,
           o.parent_ciphertext_sha256, o.created_by_device_id, o.created_at,
           o.ciphertext
      from public.vault_objects as o
     where o.user_id = v_subject
       and o.workspace_id = p_workspace_id
       and o.object_id = p_object_id;
end
$function$;

create function public.rv_read_active_generation(
  p_session_id uuid,
  p_workspace_id uuid
)
returns table (
  workspace_id uuid,
  object_id uuid,
  generation bigint,
  envelope_version smallint,
  ciphertext_sha256 text,
  signature text,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  created_by_device_id uuid,
  created_at timestamptz,
  ciphertext text,
  head_updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  if p_workspace_id is null then
    raise exception 'invalid workspace request' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  perform 1 from public.workspaces as w
   where w.user_id = v_subject and w.workspace_id = p_workspace_id;
  if not found then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  return query
    select o.workspace_id, o.object_id, o.generation, o.envelope_version,
           o.ciphertext_sha256, o.signature, o.parent_object_id,
           o.parent_ciphertext_sha256, o.created_by_device_id, o.created_at,
           o.ciphertext, h.updated_at
      from public.vault_heads as h
      join public.vault_objects as o
        on o.user_id = h.user_id
       and o.workspace_id = h.workspace_id
       and o.object_id = h.object_id
       and o.generation = h.generation
     where h.user_id = v_subject
       and h.workspace_id = p_workspace_id;
end
$function$;

create function public.rv_read_generation_history(
  p_session_id uuid,
  p_workspace_id uuid,
  p_limit integer default 8
)
returns table (
  workspace_id uuid,
  object_id uuid,
  generation bigint,
  envelope_version smallint,
  ciphertext_sha256 text,
  signature text,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  created_by_device_id uuid,
  created_at timestamptz,
  ciphertext text,
  committed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_subject uuid := auth.uid();
begin
  if p_workspace_id is null or p_limit is null or p_limit < 1 or p_limit > 16 then
    raise exception 'invalid history request' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(v_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', v_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  perform 1 from public.workspaces as w
   where w.user_id = v_subject and w.workspace_id = p_workspace_id;
  if not found then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  return query
    select o.workspace_id, o.object_id, o.generation, o.envelope_version,
           o.ciphertext_sha256, o.signature, o.parent_object_id,
           o.parent_ciphertext_sha256, o.created_by_device_id, o.created_at,
           o.ciphertext, h.committed_at
      from public.vault_head_history as h
      join public.vault_objects as o
        on o.user_id = h.user_id
       and o.workspace_id = h.workspace_id
       and o.object_id = h.object_id
       and o.generation = h.generation
     where h.user_id = v_subject
       and h.workspace_id = p_workspace_id
     order by h.generation desc, h.committed_at desc, h.object_id desc
     limit p_limit;
end
$function$;

create function public.rv_service_read_publish_context(
  p_subject uuid,
  p_session_id uuid,
  p_workspace_id uuid,
  p_object_id uuid
)
returns table (
  signing_algorithm text,
  signing_public_key text,
  object_id uuid,
  generation bigint,
  envelope_version smallint,
  ciphertext_sha256 text,
  signature text,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  head_object_id uuid,
  head_generation bigint,
  head_updated_at timestamptz,
  head_ciphertext_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_subject is null or p_workspace_id is null or p_object_id is null then
    raise exception 'invalid publish context request' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(p_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', p_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query
    select w.signing_algorithm, w.signing_public_key,
           candidate.object_id, candidate.generation, candidate.envelope_version,
           candidate.ciphertext_sha256, candidate.signature,
           candidate.parent_object_id, candidate.parent_ciphertext_sha256,
           h.object_id, h.generation, h.updated_at, head_object.ciphertext_sha256
      from public.workspaces as w
      join public.vault_objects as candidate
        on candidate.user_id = w.user_id
       and candidate.workspace_id = w.workspace_id
       and candidate.object_id = p_object_id
      left join public.vault_heads as h
        on h.user_id = w.user_id
       and h.workspace_id = w.workspace_id
      left join public.vault_objects as head_object
        on head_object.user_id = h.user_id
       and head_object.workspace_id = h.workspace_id
       and head_object.object_id = h.object_id
       and head_object.generation = h.generation
     where w.user_id = p_subject
       and w.workspace_id = p_workspace_id;
  if not found then
    raise exception 'vault candidate not found' using errcode = 'P0002';
  end if;
end
$function$;

create function public.rv_service_publish_vault_head(
  p_subject uuid,
  p_session_id uuid,
  p_workspace_id uuid,
  p_expected_generation bigint,
  p_object_id uuid
)
returns table (
  workspace_id uuid,
  object_id uuid,
  generation bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.rv_require_live_auth_session(p_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('vault', p_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_service_publish_vault_head(
    p_subject, p_session_id, p_workspace_id, p_expected_generation, p_object_id
  );
end
$function$;

create function public.rv_begin_destructive_operation(
  p_subject uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_capability_fingerprint text,
  p_subject_fingerprint text,
  p_scope_fingerprint text,
  p_operation text,
  p_receipt_id uuid,
  p_expires_at timestamptz
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.rv_require_live_auth_session(p_subject, p_session_id);
  perform private.rv_consume_subject_session_limit('destructive', p_subject, p_session_id);
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_begin_destructive_operation(
    p_subject, p_session_id, p_request_id, p_capability_fingerprint,
    p_subject_fingerprint, p_scope_fingerprint, p_operation, p_receipt_id,
    p_expires_at
  );
end
$function$;

create function public.rv_service_execute_workspace_deletion(
  p_subject uuid,
  p_session_id uuid,
  p_workspace_id uuid,
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_service_execute_workspace_deletion(
    p_subject, p_session_id, p_workspace_id, p_confirmation, p_request_id,
    p_capability_fingerprint, p_subject_fingerprint, p_scope_fingerprint
  );
end
$function$;

create function public.rv_service_execute_business_deletion(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_service_execute_business_deletion(
    p_subject, p_session_id, p_confirmation, p_request_id,
    p_capability_fingerprint, p_subject_fingerprint, p_scope_fingerprint
  );
end
$function$;

create function public.rv_mark_destructive_operation_deleting(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_mark_destructive_operation_deleting(
    p_subject, p_session_id, p_request_id, p_capability_fingerprint,
    p_subject_fingerprint, p_scope_fingerprint, p_operation
  );
end
$function$;

create function public.rv_mark_destructive_operation_completed(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_mark_destructive_operation_completed(
    p_request_id, p_capability_fingerprint, p_subject_fingerprint,
    p_scope_fingerprint, p_operation
  );
end
$function$;

create function public.rv_get_destructive_operation_status(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.rv_consume_rate_limit(
    'deletion-status-global',
    'global',
    private.rv_rate_limit_fingerprint('deletion-status-global', 'all')
  );
  perform private.rv_consume_rate_limit(
    'deletion-status',
    'capability',
    private.rv_rate_limit_fingerprint(
      'deletion-status-capability',
      coalesce(p_capability_fingerprint, '')
    )
  );
  perform private.rv_acquire_user_database_slot();
  return query select * from private.rv_core_get_destructive_operation_status(
    p_request_id, p_capability_fingerprint, p_subject_fingerprint,
    p_scope_fingerprint, p_operation
  );
end
$function$;

-- Keep limiter state bounded using the existing five-minute maintenance job.
create or replace function private.rv_run_production_vault_maintenance()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_changed bigint := 0;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  for v_rate_limit_batch in 1..4 loop
    v_changed := private.rv_prune_rate_limit_buckets();
    exit when v_changed < 500;
  end loop;

  for v_destructive_batch in 1..4 loop
    v_changed := public.rv_prune_destructive_operation_requests();
    exit when v_changed < 500;
  end loop;

  for v_vault_batch in 1..4 loop
    v_changed := public.rv_prune_vault_objects();
    exit when v_changed < 500;
  end loop;
end
$function$;

-- Remove every table-read bypass. Browser reads use authenticated RPCs;
-- publish verification uses one bounded service-only RPC.
revoke select on table public.workspaces from authenticated, service_role;
revoke select on table public.vault_objects from authenticated, service_role;
revoke select on table public.vault_heads from authenticated, service_role;
revoke select on table public.vault_head_history from authenticated, service_role;

revoke all on table private.rv_rate_limit_buckets
from public, anon, authenticated, service_role;

revoke all on function private.rv_rate_limit_fingerprint(text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_consume_rate_limit(text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_consume_subject_session_limit(text, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.rv_acquire_user_database_slot()
from public, anon, authenticated, service_role;
revoke all on function private.rv_prune_rate_limit_buckets()
from public, anon, authenticated, service_role;

revoke all on function private.rv_core_bootstrap_workspace(uuid, text, text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_register_device(uuid, uuid, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_mark_destructive_operation_completed(uuid, text, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.rv_core_get_destructive_operation_status(uuid, text, text, text, text)
from public, anon, authenticated, service_role;

revoke execute on function public.rv_bootstrap_workspace(uuid, text, text, text, uuid)
from public, anon, service_role;
revoke execute on function public.rv_register_device(uuid, uuid, text, uuid)
from public, anon, service_role;
revoke execute on function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid)
from public, anon, service_role;
revoke execute on function public.rv_list_workspaces(uuid, integer)
from public, anon, service_role;
revoke execute on function public.rv_read_generation_object(uuid, uuid, uuid)
from public, anon, service_role;
revoke execute on function public.rv_read_active_generation(uuid, uuid)
from public, anon, service_role;
revoke execute on function public.rv_read_generation_history(uuid, uuid, integer)
from public, anon, service_role;

grant execute on function public.rv_bootstrap_workspace(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.rv_register_device(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) to authenticated;
grant execute on function public.rv_list_workspaces(uuid, integer) to authenticated;
grant execute on function public.rv_read_generation_object(uuid, uuid, uuid) to authenticated;
grant execute on function public.rv_read_active_generation(uuid, uuid) to authenticated;
grant execute on function public.rv_read_generation_history(uuid, uuid, integer) to authenticated;

revoke execute on function public.rv_service_read_publish_context(uuid, uuid, uuid, uuid)
from public, anon, authenticated;
revoke execute on function public.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid)
from public, anon, authenticated;
revoke execute on function public.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz)
from public, anon, authenticated;
revoke execute on function public.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated;
revoke execute on function public.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated;
revoke execute on function public.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text)
from public, anon, authenticated;
revoke execute on function public.rv_mark_destructive_operation_completed(uuid, text, text, text, text)
from public, anon, authenticated;
revoke execute on function public.rv_get_destructive_operation_status(uuid, text, text, text, text)
from public, anon, authenticated;

grant execute on function public.rv_service_read_publish_context(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid) to service_role;
grant execute on function public.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz) to service_role;
grant execute on function public.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.rv_mark_destructive_operation_completed(uuid, text, text, text, text) to service_role;
grant execute on function public.rv_get_destructive_operation_status(uuid, text, text, text, text) to service_role;

alter function private.rv_rate_limit_fingerprint(text, text) owner to postgres;
alter function private.rv_consume_rate_limit(text, text, text) owner to postgres;
alter function private.rv_consume_subject_session_limit(text, uuid, uuid) owner to postgres;
alter function private.rv_acquire_user_database_slot() owner to postgres;
alter function private.rv_prune_rate_limit_buckets() owner to postgres;
alter function private.rv_run_production_vault_maintenance() owner to postgres;

comment on function private.rv_acquire_user_database_slot() is
  'Acquires one of ten transaction-scoped PostgreSQL advisory-lock slots; it is not an Edge HTTP or whole-project concurrency limit.';
comment on function public.rv_get_destructive_operation_status(uuid, text, text, text, text) is
  'Anonymous-capability status lookup protected by a 10/min capability bucket and 60/min global bucket; the global bucket can be exhausted as a one-minute availability denial on Free.';

commit;

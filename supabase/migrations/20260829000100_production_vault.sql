-- Review Workbench production vault baseline.
--
-- APPLY ONLY TO A NEW, DEDICATED SUPABASE PROJECT.
-- The preflight guard intentionally rejects both the legacy Review Workbench
-- schema and a partially-installed production vault.

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

do $cron_installer$
begin
  if current_user <> 'postgres' then
    raise exception 'production vault cron must be installed by postgres'
      using errcode = '42501';
  end if;
end
$cron_installer$;

create schema if not exists private authorization postgres;

do $preflight$
declare
  v_conflicts text;
  v_auth_sessions regclass;
  v_auth_session_columns integer;
begin
  select string_agg(t.table_name, ', ' order by t.table_name)
    into v_conflicts
    from information_schema.tables as t
   where t.table_schema = 'public'
     and t.table_type = 'BASE TABLE'
     and t.table_name = any (array[
       -- Legacy/single-owner Review Workbench tables.
       'trades', 'journal_entries', 'guards', 'annotations',
       'fills', 'orders', 'income', 'sync_runs', 'daily_rollups',
       -- Production-vault tables. Their presence means this is not a clean baseline.
       'profiles', 'workspaces', 'devices', 'vault_objects',
       'vault_heads', 'vault_head_history', 'deletion_jobs',
       'account_deletion_requests', 'destructive_operation_requests'
     ]);

  if v_conflicts is not null then
    raise exception
      'production vault requires a new dedicated project; conflicting public tables: %',
      v_conflicts
      using errcode = 'P0001';
  end if;

  -- Immediate revocation depends on the current hosted Auth session contract.
  -- Fail deliberately if an upstream Auth release changes that internal table
  -- instead of creating policies that only break after deployment.
  v_auth_sessions := to_regclass('auth.sessions');
  if v_auth_sessions is null then
    raise exception 'production vault requires the current Supabase auth.sessions contract'
      using errcode = 'P0001';
  end if;
  select count(*)
    into v_auth_session_columns
    from pg_catalog.pg_attribute as a
   where a.attrelid = v_auth_sessions
     and a.attnum > 0
     and not a.attisdropped
     and a.attname = any (array['id', 'user_id', 'not_after']);
  if v_auth_session_columns <> 3 then
    raise exception 'production vault requires auth.sessions id, user_id, and not_after columns'
      using errcode = 'P0001';
  end if;
end
$preflight$;

create table public.profiles (
  user_id uuid not null default auth.uid(),
  vault_schema_version smallint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  constraint profiles_pkey primary key (user_id),
  constraint profiles_user_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint profiles_vault_schema_version_check
    check (vault_schema_version = 1)
);

create table public.workspaces (
  user_id uuid not null default auth.uid(),
  workspace_id uuid not null default gen_random_uuid(),
  signing_algorithm text not null,
  signing_public_key text not null,
  write_capability_hash text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint workspaces_pkey primary key (user_id, workspace_id),
  constraint workspaces_user_fkey
    foreign key (user_id) references public.profiles (user_id) on delete cascade,
  constraint workspaces_signing_algorithm_check
    check (signing_algorithm = 'ed25519-v1'),
  constraint workspaces_signing_public_key_check
    check (signing_public_key ~ '^[A-Za-z0-9_-]{59}$'),
  constraint workspaces_write_capability_hash_check
    check (write_capability_hash ~ '^[0-9a-f]{64}$')
);

create table public.devices (
  user_id uuid not null default auth.uid(),
  workspace_id uuid not null,
  device_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint devices_pkey primary key (user_id, workspace_id, device_id),
  constraint devices_workspace_fkey
    foreign key (user_id, workspace_id)
    references public.workspaces (user_id, workspace_id)
    on delete cascade,
  constraint devices_last_seen_check
    check (last_seen_at is null or last_seen_at >= created_at),
  constraint devices_revoked_at_check
    check (revoked_at is null or revoked_at >= created_at)
);

create table public.vault_objects (
  user_id uuid not null default auth.uid(),
  workspace_id uuid not null,
  object_id uuid not null default gen_random_uuid(),
  generation bigint not null,
  envelope_version smallint not null default 1,
  ciphertext text not null,
  ciphertext_sha256 text not null,
  signature text not null,
  parent_object_id uuid,
  parent_ciphertext_sha256 text,
  ciphertext_bytes integer generated always as (
    octet_length(decode(ciphertext, 'base64'))
  ) stored,
  created_by_device_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint vault_objects_pkey
    primary key (user_id, workspace_id, object_id),
  constraint vault_objects_identity_generation_key
    unique (user_id, workspace_id, object_id, generation),
  constraint vault_objects_workspace_fkey
    foreign key (user_id, workspace_id)
    references public.workspaces (user_id, workspace_id)
    on delete cascade,
  constraint vault_objects_device_fkey
    foreign key (user_id, workspace_id, created_by_device_id)
    references public.devices (user_id, workspace_id, device_id)
    deferrable initially deferred,
  constraint vault_objects_generation_check check (generation > 0),
  constraint vault_objects_envelope_version_check check (envelope_version = 1),
  constraint vault_objects_ciphertext_sha256_check
    check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  constraint vault_objects_signature_check
    check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  constraint vault_objects_parent_check
    check (
      (generation = 1
        and parent_object_id is null
        and parent_ciphertext_sha256 is null)
      or
      (generation > 1
        and parent_object_id is not null
        and parent_ciphertext_sha256 ~ '^[0-9a-f]{64}$')
    ),
  constraint vault_objects_ciphertext_base64_check
    check (
      ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'
      and char_length(ciphertext) % 4 = 0
      and ciphertext_bytes between 17 and 25165824
    )
);

create table public.vault_heads (
  user_id uuid not null default auth.uid(),
  workspace_id uuid not null,
  object_id uuid not null,
  generation bigint not null,
  updated_at timestamptz not null default statement_timestamp(),
  constraint vault_heads_pkey primary key (user_id, workspace_id),
  constraint vault_heads_object_fkey
    foreign key (user_id, workspace_id, object_id, generation)
    references public.vault_objects
      (user_id, workspace_id, object_id, generation)
    on delete cascade,
  constraint vault_heads_generation_check check (generation > 0)
);

-- Append-only evidence of generations that actually won the head CAS. Uploaded
-- losing candidates never enter this table and therefore cannot be selected by
-- the client's read-only history recovery path.
create table public.vault_head_history (
  user_id uuid not null,
  workspace_id uuid not null,
  generation bigint not null,
  object_id uuid not null,
  committed_at timestamptz not null default statement_timestamp(),
  constraint vault_head_history_pkey
    primary key (user_id, workspace_id, generation),
  constraint vault_head_history_object_key
    unique (user_id, workspace_id, object_id),
  constraint vault_head_history_object_fkey
    foreign key (user_id, workspace_id, object_id, generation)
    references public.vault_objects
      (user_id, workspace_id, object_id, generation)
    on delete cascade,
  constraint vault_head_history_generation_check check (generation > 0)
);

-- Short-lived, capability-addressed state for every destructive operation.
-- It deliberately has no FK or plaintext link to auth.users/workspaces, so a
-- completion receipt survives the deletion without retaining either identity.
create table public.destructive_operation_requests (
  request_id uuid not null,
  capability_fingerprint text not null,
  subject_fingerprint text not null,
  scope_fingerprint text not null,
  operation text not null,
  status text not null default 'pending',
  receipt_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  constraint destructive_operation_requests_pkey primary key (request_id),
  constraint destructive_operation_requests_capability_key unique (capability_fingerprint),
  constraint destructive_operation_requests_receipt_key unique (receipt_id),
  constraint destructive_operation_requests_capability_fingerprint_check
    check (capability_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint destructive_operation_requests_subject_fingerprint_check
    check (subject_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint destructive_operation_requests_scope_fingerprint_check
    check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint destructive_operation_requests_operation_check
    check (operation in ('delete_workspace', 'clear_business_data', 'delete_account')),
  constraint destructive_operation_requests_status_check
    check (status in ('pending', 'deleting', 'completed')),
  constraint destructive_operation_requests_ttl_check
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '1 hour'
    ),
  constraint destructive_operation_requests_updated_check
    check (updated_at >= created_at),
  constraint destructive_operation_requests_completed_check
    check (
      (status <> 'completed' and completed_at is null)
      or
      (status = 'completed' and completed_at is not null
        and completed_at >= created_at)
    )
);

create index destructive_operation_requests_expires_at_idx
  on public.destructive_operation_requests (expires_at);

comment on table public.profiles is
  'Minimal tenant control-plane row. Contains no email, name, or trading data.';
comment on table public.workspaces is
  'Opaque tenant workspace identity. User-defined labels belong inside ciphertext.';
comment on table public.devices is
  'Opaque device identity and revocation status only; no recovery secret or key material.';
comment on table public.vault_objects is
  'Immutable client-encrypted workspace snapshots; no normalized trading fields.';
comment on table public.vault_heads is
  'CAS-controlled pointer to the active immutable encrypted snapshot.';
comment on table public.vault_head_history is
  'Append-only list of immutable ciphertext objects that successfully became an active head; excludes uploaded CAS losers.';
comment on table public.destructive_operation_requests is
  'Short-lived idempotency state containing operation labels, random IDs, and keyed HMAC fingerprints only; no user/workspace ID, email, JWT, or recovery secret.';

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.devices enable row level security;
alter table public.devices force row level security;
alter table public.vault_objects enable row level security;
alter table public.vault_objects force row level security;
alter table public.vault_heads enable row level security;
alter table public.vault_heads force row level security;
alter table public.vault_head_history enable row level security;
alter table public.vault_head_history force row level security;
alter table public.destructive_operation_requests enable row level security;
alter table public.destructive_operation_requests force row level security;

-- A signing root and an uploaded generation are append-only security records.
-- This trigger also blocks accidental service-role mutation; reviewed account
-- and workspace deletion still use DELETE and their declared cascades.
create function public.rv_reject_immutable_update()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  if tg_table_schema <> 'public' then
    raise exception 'immutable record' using errcode = '55000';
  end if;
  if tg_table_name = 'workspaces' then
    if new.signing_algorithm is distinct from old.signing_algorithm
       or new.signing_public_key is distinct from old.signing_public_key
       or new.write_capability_hash is distinct from old.write_capability_hash then
      raise exception 'workspace signing root is immutable' using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_table_name = 'vault_objects' then
    raise exception 'vault object is immutable' using errcode = '55000';
  end if;
  raise exception 'immutable record' using errcode = '55000';
end
$function$;

create trigger rv_workspaces_root_immutable
before update on public.workspaces
for each row execute function public.rv_reject_immutable_update();

create trigger rv_vault_objects_immutable
before update on public.vault_objects
for each row execute function public.rv_reject_immutable_update();

-- Quotas are enforced below RLS at one shared, concurrency-safe boundary.
-- The keyed advisory transaction lock serializes every quota-increasing insert
-- for a tenant; policy subqueries alone would allow concurrent over-allocation.
create function public.rv_enforce_tenant_quota()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_workspace_limit constant integer := 16;
  v_device_limit constant integer := 16;
  v_object_limit constant integer := 2048;
  v_total_bytes_limit constant bigint := 536870912;
  v_count bigint := 0;
  v_total_bytes bigint := 0;
  v_new_bytes integer := 0;
begin
  if new.user_id is null
     or tg_table_schema <> 'public'
     or tg_table_name not in ('workspaces', 'devices', 'vault_objects') then
    raise exception 'tenant quota unavailable' using errcode = '55000';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('review-workbench-quota:' || new.user_id::text, 0)
  );

  if tg_table_name = 'workspaces' then
    if exists (
      select 1 from public.workspaces as w
       where w.user_id = new.user_id
         and w.workspace_id = new.workspace_id
    ) then
      return new;
    end if;
    select count(*) into v_count
      from public.workspaces as w
     where w.user_id = new.user_id;
    if v_count >= v_workspace_limit then
      raise exception 'tenant quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if tg_table_name = 'devices' then
    if exists (
      select 1 from public.devices as d
       where d.user_id = new.user_id
         and d.workspace_id = new.workspace_id
         and d.device_id = new.device_id
    ) then
      return new;
    end if;
    select count(*) into v_count
      from public.devices as d
     where d.user_id = new.user_id
       and d.workspace_id = new.workspace_id;
    if v_count >= v_device_limit then
      raise exception 'tenant quota exceeded' using errcode = '54000';
    end if;
    return new;
  end if;

  if exists (
    select 1 from public.vault_objects as o
     where o.user_id = new.user_id
       and o.workspace_id = new.workspace_id
       and o.object_id = new.object_id
  ) then
    return new;
  end if;
  begin
    v_new_bytes := octet_length(decode(new.ciphertext, 'base64'));
  exception when others then
    raise exception 'invalid encrypted object' using errcode = '22023';
  end;
  if v_new_bytes is null or v_new_bytes < 17 or v_new_bytes > 25165824 then
    raise exception 'tenant quota exceeded' using errcode = '54000';
  end if;
  select count(*), coalesce(sum(o.ciphertext_bytes), 0)
    into v_count, v_total_bytes
    from public.vault_objects as o
   where o.user_id = new.user_id;
  if v_count >= v_object_limit
     or v_total_bytes > v_total_bytes_limit - v_new_bytes then
    raise exception 'tenant quota exceeded' using errcode = '54000';
  end if;
  return new;
end
$function$;

create trigger rv_quota_workspaces_before_insert
before insert on public.workspaces
for each row execute function public.rv_enforce_tenant_quota();

create trigger rv_quota_devices_before_insert
before insert on public.devices
for each row execute function public.rv_enforce_tenant_quota();

create trigger rv_quota_vault_objects_before_insert
before insert on public.vault_objects
for each row execute function public.rv_enforce_tenant_quota();

-- Every cloud-vault operation binds the bearer JWT to a currently live
-- auth.sessions row. Authenticated RPCs must present their exact session_id
-- claim; service-role Edge calls pass the session_id extracted from the exact
-- JWT verified through /auth/v1/user. A row lock orders revocation and guarded
-- writes in the same transaction.
create function public.rv_require_live_auth_session(
  p_subject uuid,
  p_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_role text := coalesce(auth.role(), '');
begin
  if v_role not in ('authenticated', 'service_role') then
    raise exception 'authenticated or service role required' using errcode = '42501';
  end if;

  if p_subject is null or p_session_id is null then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
  if v_role = 'authenticated' and (
    auth.uid() is distinct from p_subject
    or (auth.jwt() ->> 'session_id') is distinct from p_session_id::text
  ) then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;

  perform 1
    from auth.sessions as s
   where s.user_id = p_subject
     and s.id = p_session_id
     and (s.not_after is null or s.not_after > statement_timestamp())
   for key share;
  if not found then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
end
$function$;

create function public.rv_current_session_is_live()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if coalesce(auth.role(), '') <> 'authenticated'
     or auth.uid() is null
     or v_session_id is null
     or v_session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
  perform 1
    from auth.sessions as s
   where s.user_id = auth.uid()
     and s.id = v_session_id::uuid
     and (s.not_after is null or s.not_after > statement_timestamp());
  if not found then
    raise exception 'live auth session required' using errcode = 'P0003';
  end if;
  return true;
end
$function$;

create policy profiles_owner_select
  on public.profiles for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

create policy workspaces_owner_select
  on public.workspaces for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

create policy devices_owner_select
  on public.devices for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

create policy vault_objects_owner_select
  on public.vault_objects for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

create policy vault_heads_owner_select
  on public.vault_heads for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

create policy vault_head_history_owner_select
  on public.vault_head_history for select to authenticated
  using ((select public.rv_current_session_is_live()) and user_id = (select auth.uid()));

-- Bootstrap pins one Ed25519 signing root and one SHA-256 capability hash. An
-- exact retry is idempotent; no RPC can rotate or replace these root fields.
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
  v_user_id uuid := auth.uid();
  v_capability_hash text;
  v_public_key_der bytea;
  v_row public.workspaces%rowtype;
begin
  if v_user_id is null or p_workspace_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.rv_require_live_auth_session(v_user_id, p_session_id);
  if p_signing_algorithm is distinct from 'ed25519-v1'
     or p_signing_public_key is null
     or p_write_capability is null
     or p_signing_public_key !~ '^[A-Za-z0-9_-]{59}$'
     or p_write_capability !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid workspace signing root' using errcode = '22023';
  end if;
  begin
    v_public_key_der := decode(
      translate(p_signing_public_key, '-_', '+/') || '=',
      'base64'
    );
  exception when others then
    raise exception 'invalid workspace signing root' using errcode = '22023';
  end;
  if octet_length(v_public_key_der) <> 44
     or encode(v_public_key_der, 'hex') !~ '^302a300506032b6570032100[0-9a-f]{64}$' then
    raise exception 'invalid workspace signing root' using errcode = '22023';
  end if;
  v_capability_hash := encode(
    extensions.digest(convert_to(p_write_capability, 'utf8'), 'sha256'),
    'hex'
  );

  insert into public.profiles (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  insert into public.workspaces (
    user_id, workspace_id, signing_algorithm,
    signing_public_key, write_capability_hash
  )
  values (
    v_user_id, p_workspace_id, p_signing_algorithm,
    p_signing_public_key, v_capability_hash
  )
  on conflict (user_id, workspace_id) do nothing;

  select w.* into v_row
    from public.workspaces as w
   where w.user_id = v_user_id
     and w.workspace_id = p_workspace_id;
  if not found
     or v_row.signing_algorithm is distinct from p_signing_algorithm
     or v_row.signing_public_key is distinct from p_signing_public_key
     or v_row.write_capability_hash is distinct from v_capability_hash then
    raise exception 'workspace signing root conflict' using errcode = '23505';
  end if;

  return query select
    v_row.workspace_id,
    v_row.signing_algorithm,
    v_row.signing_public_key,
    v_row.created_at;
end
$function$;

-- Device registration and candidate upload both require possession of the
-- 256-bit write capability. Only its SHA-256 hash is retained server-side.
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
  v_user_id uuid := auth.uid();
  v_capability_hash text;
  v_row public.devices%rowtype;
  v_changed bigint := 0;
begin
  if v_user_id is null or p_workspace_id is null or p_device_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.rv_require_live_auth_session(v_user_id, p_session_id);
  if p_write_capability is null or p_write_capability !~ '^[0-9a-f]{64}$' then
    raise exception 'write capability rejected' using errcode = '42501';
  end if;
  v_capability_hash := encode(
    extensions.digest(convert_to(p_write_capability, 'utf8'), 'sha256'),
    'hex'
  );
  perform 1
    from public.workspaces as w
   where w.user_id = v_user_id
     and w.workspace_id = p_workspace_id
     and w.write_capability_hash = v_capability_hash;
  if not found then
    raise exception 'write capability rejected' using errcode = '42501';
  end if;

  insert into public.devices (
    user_id, workspace_id, device_id, last_seen_at
  ) values (
    v_user_id, p_workspace_id, p_device_id, statement_timestamp()
  )
  on conflict (user_id, workspace_id, device_id) do update
    set last_seen_at = statement_timestamp()
    where public.devices.revoked_at is null;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'device unavailable' using errcode = '42501';
  end if;

  select d.* into v_row
    from public.devices as d
   where d.user_id = v_user_id
     and d.workspace_id = p_workspace_id
     and d.device_id = p_device_id
     and d.revoked_at is null;
  if not found then
    raise exception 'device unavailable' using errcode = '42501';
  end if;
  return query select
    v_row.workspace_id, v_row.device_id, v_row.created_at,
    v_row.last_seen_at, v_row.revoked_at;
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
  v_user_id uuid := auth.uid();
  v_capability_hash text;
  v_ciphertext_bytes integer;
  v_ciphertext_sha256 text;
  v_signature_bytes bytea;
  v_row public.vault_objects%rowtype;
begin
  if v_user_id is null
     or p_workspace_id is null
     or p_device_id is null
     or p_object_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.rv_require_live_auth_session(v_user_id, p_session_id);
  if p_write_capability is null or p_write_capability !~ '^[0-9a-f]{64}$' then
    raise exception 'write capability rejected' using errcode = '42501';
  end if;
  v_capability_hash := encode(
    extensions.digest(convert_to(p_write_capability, 'utf8'), 'sha256'),
    'hex'
  );

  perform 1
    from public.workspaces as w
   where w.user_id = v_user_id
     and w.workspace_id = p_workspace_id
     and w.write_capability_hash = v_capability_hash;
  if not found then
    raise exception 'write capability rejected' using errcode = '42501';
  end if;
  perform 1
    from public.devices as d
   where d.user_id = v_user_id
     and d.workspace_id = p_workspace_id
     and d.device_id = p_device_id
     and d.revoked_at is null;
  if not found then
    raise exception 'device unavailable' using errcode = '42501';
  end if;

  if p_generation is null or p_generation < 1 or p_generation > 9007199254740991
     or p_envelope_version is distinct from 1
     or p_ciphertext is null
     or p_ciphertext_sha256 is null
     or p_signature is null
     or char_length(p_ciphertext) < 24
     or char_length(p_ciphertext) > 33554432
     or char_length(p_ciphertext) % 4 <> 0
     or p_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$'
     or p_ciphertext_sha256 !~ '^[0-9a-f]{64}$'
     or p_signature !~ '^[A-Za-z0-9_-]{86}$' then
    raise exception 'invalid encrypted generation' using errcode = '22023';
  end if;
  begin
    v_ciphertext_bytes := octet_length(decode(p_ciphertext, 'base64'));
    v_ciphertext_sha256 := encode(
      extensions.digest(decode(p_ciphertext, 'base64'), 'sha256'),
      'hex'
    );
    v_signature_bytes := decode(
      translate(p_signature, '-_', '+/') || '==',
      'base64'
    );
  exception when others then
    raise exception 'invalid encrypted generation' using errcode = '22023';
  end;
  if v_ciphertext_bytes < 17 or v_ciphertext_bytes > 25165824
     or v_ciphertext_sha256 is distinct from p_ciphertext_sha256
     or octet_length(v_signature_bytes) <> 64 then
    raise exception 'invalid encrypted generation' using errcode = '22023';
  end if;

  if p_generation = 1 then
    if p_parent_object_id is not null or p_parent_ciphertext_sha256 is not null then
      raise exception 'invalid generation parent' using errcode = '22023';
    end if;
  else
    if p_parent_object_id is null
       or p_parent_ciphertext_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid generation parent' using errcode = '22023';
    end if;
    perform 1
      from public.vault_objects as parent
     where parent.user_id = v_user_id
       and parent.workspace_id = p_workspace_id
       and parent.object_id = p_parent_object_id
       and parent.generation = p_generation - 1
       and parent.ciphertext_sha256 = p_parent_ciphertext_sha256;
    if not found then
      raise exception 'generation parent not found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.vault_objects (
    user_id, workspace_id, object_id, generation, envelope_version,
    ciphertext, ciphertext_sha256, signature,
    parent_object_id, parent_ciphertext_sha256, created_by_device_id
  ) values (
    v_user_id, p_workspace_id, p_object_id, p_generation, p_envelope_version,
    p_ciphertext, v_ciphertext_sha256, p_signature,
    p_parent_object_id, p_parent_ciphertext_sha256, p_device_id
  ) on conflict (user_id, workspace_id, object_id) do nothing;

  select o.* into v_row
    from public.vault_objects as o
   where o.user_id = v_user_id
     and o.workspace_id = p_workspace_id
     and o.object_id = p_object_id;
  if not found
     or v_row.generation is distinct from p_generation
     or v_row.envelope_version is distinct from p_envelope_version
     or v_row.ciphertext is distinct from p_ciphertext
     or v_row.ciphertext_sha256 is distinct from v_ciphertext_sha256
     or v_row.signature is distinct from p_signature
     or v_row.parent_object_id is distinct from p_parent_object_id
     or v_row.parent_ciphertext_sha256 is distinct from p_parent_ciphertext_sha256
     or v_row.created_by_device_id is distinct from p_device_id then
    raise exception 'vault object idempotency conflict' using errcode = '23505';
  end if;

  return query select
    v_row.workspace_id, v_row.object_id, v_row.generation,
    v_row.envelope_version, v_row.ciphertext_sha256, v_row.signature,
    v_row.parent_object_id, v_row.parent_ciphertext_sha256,
    v_row.created_by_device_id, v_row.created_at;
end
$function$;

-- The browser cannot execute this CAS. The publish-vault-head Edge Function
-- first verifies the JWT, exact chain parent, and Ed25519 manifest signature,
-- then supplies its server-verified subject through service_role.
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
declare
  v_object public.vault_objects%rowtype;
  v_head_object_id uuid;
  v_head_generation bigint;
  v_head_ciphertext_sha256 text;
  v_updated_at timestamptz := statement_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_subject is null or p_workspace_id is null or p_object_id is null
     or p_expected_generation is null
     or p_expected_generation < 0
     or p_expected_generation >= 9007199254740991 then
    raise exception 'invalid publish request' using errcode = '22023';
  end if;
  perform public.rv_require_live_auth_session(p_subject, p_session_id);

  perform 1
    from public.workspaces as w
   where w.user_id = p_subject
     and w.workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;

  select o.* into v_object
    from public.vault_objects as o
   where o.user_id = p_subject
     and o.workspace_id = p_workspace_id
     and o.object_id = p_object_id;
  if not found then
    raise exception 'vault object not found' using errcode = 'P0002';
  end if;
  if v_object.generation <> p_expected_generation + 1 then
    raise exception 'vault head compare-and-swap conflict' using errcode = '40001';
  end if;
  perform 1
    from public.devices as d
   where d.user_id = p_subject
     and d.workspace_id = p_workspace_id
     and d.device_id = v_object.created_by_device_id
     and d.revoked_at is null;
  if not found then
    raise exception 'vault object device unavailable' using errcode = 'P0002';
  end if;

  if p_expected_generation = 0 then
    perform 1
      from public.vault_heads as h
     where h.user_id = p_subject
       and h.workspace_id = p_workspace_id;
    if found
       or v_object.parent_object_id is not null
       or v_object.parent_ciphertext_sha256 is not null then
      raise exception 'vault head compare-and-swap conflict' using errcode = '40001';
    end if;
    insert into public.vault_heads (
      user_id, workspace_id, object_id, generation, updated_at
    )
    values (
      p_subject, p_workspace_id, p_object_id,
      v_object.generation, v_updated_at
    );
  else
    select h.object_id, h.generation, parent.ciphertext_sha256
      into v_head_object_id, v_head_generation, v_head_ciphertext_sha256
      from public.vault_heads as h
      join public.vault_objects as parent
        on parent.user_id = h.user_id
       and parent.workspace_id = h.workspace_id
       and parent.object_id = h.object_id
       and parent.generation = h.generation
     where h.user_id = p_subject
       and h.workspace_id = p_workspace_id;
    if not found
       or v_head_generation <> p_expected_generation
       or v_object.parent_object_id is distinct from v_head_object_id
       or v_object.parent_ciphertext_sha256 is distinct from v_head_ciphertext_sha256 then
      raise exception 'vault head compare-and-swap conflict' using errcode = '40001';
    end if;
    update public.vault_heads as h
       set object_id = p_object_id,
           generation = v_object.generation,
           updated_at = v_updated_at
     where h.user_id = p_subject
       and h.workspace_id = p_workspace_id
       and h.generation = p_expected_generation;
  end if;

  insert into public.vault_head_history (
    user_id, workspace_id, generation, object_id, committed_at
  ) values (
    p_subject, p_workspace_id, v_object.generation, p_object_id, v_updated_at
  );

  return query
    select h.workspace_id, h.object_id, h.generation, h.updated_at
      from public.vault_heads as h
     where h.user_id = p_subject
       and h.workspace_id = p_workspace_id;
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
declare
  v_row public.destructive_operation_requests%rowtype;
begin
  if p_subject is null or p_workspace_id is null then
    raise exception 'verified subject required' using errcode = '22023';
  end if;
  if p_confirmation is distinct from 'DELETE_THIS_WORKSPACE' then
    raise exception 'confirmation text mismatch' using errcode = '22023';
  end if;

  perform public.rv_require_live_auth_session(p_subject, p_session_id);

  select r.* into v_row
    from public.destructive_operation_requests as r
   where r.request_id = p_request_id
     and r.capability_fingerprint = p_capability_fingerprint
     and r.subject_fingerprint = p_subject_fingerprint
     and r.scope_fingerprint = p_scope_fingerprint
     and r.operation = 'delete_workspace'
     and r.expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'destructive operation not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'completed' then
    return query select v_row.request_id, v_row.operation, v_row.status,
      v_row.receipt_id, v_row.expires_at;
    return;
  end if;

  update public.destructive_operation_requests as r
     set status = 'deleting', updated_at = statement_timestamp()
   where r.request_id = v_row.request_id;

  delete from public.workspaces as w
   where w.user_id = p_subject
     and w.workspace_id = p_workspace_id;

  update public.destructive_operation_requests as r
     set status = 'completed',
         updated_at = statement_timestamp(),
         completed_at = statement_timestamp()
   where r.request_id = v_row.request_id
  returning r.* into v_row;
  return query select v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
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
declare
  v_row public.destructive_operation_requests%rowtype;
begin
  if p_subject is null then
    raise exception 'verified subject required' using errcode = '22023';
  end if;
  if p_confirmation is distinct from 'DELETE_MY_REVIEW_DATA' then
    raise exception 'confirmation text mismatch' using errcode = '22023';
  end if;

  perform public.rv_require_live_auth_session(p_subject, p_session_id);

  select r.* into v_row
    from public.destructive_operation_requests as r
   where r.request_id = p_request_id
     and r.capability_fingerprint = p_capability_fingerprint
     and r.subject_fingerprint = p_subject_fingerprint
     and r.scope_fingerprint = p_scope_fingerprint
     and r.operation = 'clear_business_data'
     and r.expires_at > statement_timestamp()
   for update;
  if not found then
    raise exception 'destructive operation not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'completed' then
    return query select v_row.request_id, v_row.operation, v_row.status,
      v_row.receipt_id, v_row.expires_at;
    return;
  end if;

  update public.destructive_operation_requests as r
     set status = 'deleting', updated_at = statement_timestamp()
   where r.request_id = v_row.request_id;

  -- The profiles -> workspaces -> devices/objects/heads cascade removes every
  -- product content row for this user. The capability receipt is separate.
  delete from public.profiles as p
   where p.user_id = p_subject;

  update public.destructive_operation_requests as r
     set status = 'completed',
         updated_at = statement_timestamp(),
         completed_at = statement_timestamp()
   where r.request_id = v_row.request_id
  returning r.* into v_row;
  return query select v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
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
declare
  v_row public.destructive_operation_requests%rowtype;
begin
  if p_request_id is null or p_receipt_id is null
     or p_capability_fingerprint is null
     or p_capability_fingerprint !~ '^[0-9a-f]{64}$'
     or p_subject_fingerprint is null
     or p_subject_fingerprint !~ '^[0-9a-f]{64}$'
     or p_scope_fingerprint is null
     or p_scope_fingerprint !~ '^[0-9a-f]{64}$'
     or p_operation is null
     or p_operation not in ('delete_workspace', 'clear_business_data', 'delete_account')
     or p_expires_at is null
     or p_expires_at <= statement_timestamp()
     or p_expires_at > statement_timestamp() + interval '1 hour' then
    raise exception 'invalid destructive operation capability' using errcode = '22023';
  end if;

  perform public.rv_require_live_auth_session(p_subject, p_session_id);

  insert into public.destructive_operation_requests (
    request_id, capability_fingerprint, subject_fingerprint, scope_fingerprint,
    operation, status, receipt_id, created_at, updated_at, expires_at
  ) values (
    p_request_id, p_capability_fingerprint, p_subject_fingerprint, p_scope_fingerprint,
    p_operation, 'pending', p_receipt_id,
    statement_timestamp(), statement_timestamp(), p_expires_at
  ) on conflict (request_id) do nothing;

  select r.* into v_row
    from public.destructive_operation_requests as r
   where r.request_id = p_request_id;
  if not found
     or v_row.capability_fingerprint is distinct from p_capability_fingerprint
     or v_row.subject_fingerprint is distinct from p_subject_fingerprint
     or v_row.scope_fingerprint is distinct from p_scope_fingerprint
     or v_row.operation is distinct from p_operation then
    raise exception 'destructive operation idempotency conflict' using errcode = '23505';
  end if;

  return query select v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
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
declare
  v_row public.destructive_operation_requests%rowtype;
begin
  perform public.rv_require_live_auth_session(p_subject, p_session_id);

  update public.destructive_operation_requests as r
     set status = case when r.status = 'completed' then 'completed' else 'deleting' end,
         updated_at = statement_timestamp()
   where r.request_id = p_request_id
     and r.capability_fingerprint = p_capability_fingerprint
     and r.subject_fingerprint = p_subject_fingerprint
     and r.scope_fingerprint = p_scope_fingerprint
     and r.operation = p_operation
     and r.expires_at > statement_timestamp()
  returning r.* into v_row;
  if not found then
    raise exception 'destructive operation not found' using errcode = 'P0002';
  end if;
  return query select v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
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
declare
  v_row public.destructive_operation_requests%rowtype;
begin
  update public.destructive_operation_requests as r
     set status = 'completed',
         updated_at = statement_timestamp(),
         completed_at = coalesce(r.completed_at, statement_timestamp())
   where r.request_id = p_request_id
     and r.capability_fingerprint = p_capability_fingerprint
     and r.subject_fingerprint = p_subject_fingerprint
     and r.scope_fingerprint = p_scope_fingerprint
     and r.operation = p_operation
     and r.expires_at > statement_timestamp()
  returning r.* into v_row;
  if not found then
    raise exception 'destructive operation not found' using errcode = 'P0002';
  end if;
  return query select v_row.request_id, v_row.operation, v_row.status,
    v_row.receipt_id, v_row.expires_at;
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
language sql
security definer
set search_path = pg_catalog
as $function$
  select r.request_id, r.operation, r.status, r.receipt_id, r.expires_at
    from public.destructive_operation_requests as r
   where r.request_id = p_request_id
     and r.capability_fingerprint = p_capability_fingerprint
     and r.subject_fingerprint = p_subject_fingerprint
     and r.scope_fingerprint = p_scope_fingerprint
     and r.operation = p_operation;
$function$;

create function public.rv_prune_destructive_operation_requests()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_changed bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  with expired as (
    select candidate.request_id
      from public.destructive_operation_requests as candidate
     where candidate.expires_at <= statement_timestamp()
     order by candidate.expires_at, candidate.request_id
     limit 500
     for update skip locked
  )
  delete from public.destructive_operation_requests as r
   using expired
   where r.request_id = expired.request_id;
  get diagnostics v_changed = row_count;
  return v_changed;
end
$function$;

-- Reclaim immutable ciphertext without reducing the four-generation recovery
-- window. Locking the workspace row serializes collection with head publication,
-- upload, and workspace deletion, so an object cannot become the current head
-- after it has been selected for deletion.
create function public.rv_prune_vault_objects()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_changed bigint := 0;
  v_deleted bigint := 0;
  v_candidate record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_candidate in
    with ranked_history as materialized (
      select
        h.user_id,
        h.workspace_id,
        h.object_id,
        row_number() over (
          partition by h.user_id, h.workspace_id
          order by h.generation desc, h.committed_at desc, h.object_id desc
        ) as committed_rank
      from public.vault_head_history as h
    )
    select o.user_id, o.workspace_id, o.object_id
      from public.vault_objects as o
      join public.workspaces as locked_workspace
        on locked_workspace.user_id = o.user_id
       and locked_workspace.workspace_id = o.workspace_id
      left join ranked_history as history
        on history.user_id = o.user_id
       and history.workspace_id = o.workspace_id
       and history.object_id = o.object_id
     where not exists (
       select 1
         from public.vault_heads as current_head
        where current_head.user_id = o.user_id
          and current_head.workspace_id = o.workspace_id
          and current_head.object_id = o.object_id
     )
       and (
         (history.object_id is not null and history.committed_rank > 4)
         or
         (history.object_id is null
           and o.created_at <= statement_timestamp() - interval '24 hours')
       )
     order by o.created_at, o.user_id, o.workspace_id, o.object_id
     limit 500
     for update of locked_workspace, o skip locked
  loop
    -- This second statement gets a fresh READ COMMITTED snapshot after the
    -- workspace lock. It closes the narrow race where a publisher committed
    -- between the candidate snapshot and lock acquisition.
    delete from public.vault_objects as doomed
     where doomed.user_id = v_candidate.user_id
       and doomed.workspace_id = v_candidate.workspace_id
       and doomed.object_id = v_candidate.object_id
       and not exists (
         select 1
           from public.vault_heads as current_head_after_lock
          where current_head_after_lock.user_id = doomed.user_id
            and current_head_after_lock.workspace_id = doomed.workspace_id
            and current_head_after_lock.object_id = doomed.object_id
       );
    get diagnostics v_deleted = row_count;
    v_changed := v_changed + v_deleted;
  end loop;
  return v_changed;
end
$function$;

-- pg_cron connects as postgres and calls this private, network-free wrapper.
-- The transaction-local role claim lets the same service-only guards protect
-- scheduled and Edge-triggered maintenance without storing a service key.
create function private.rv_run_production_vault_maintenance()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_changed bigint := 0;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

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

alter function private.rv_run_production_vault_maintenance() owner to postgres;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to postgres;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated, service_role;
revoke all on function private.rv_run_production_vault_maintenance()
from public, anon, authenticated, service_role;
grant execute on function private.rv_run_production_vault_maintenance() to postgres;

select cron.schedule(
  'rv-production-vault-maintenance',
  '*/5 * * * *',
  $cron$select private.rv_run_production_vault_maintenance();$cron$
);

select cron.schedule(
  'rv-pg-cron-run-details-retention',
  '17 3 * * *',
  $cron$delete from cron.job_run_details
    where end_time < now() - interval '7 days';$cron$
);

-- Fail closed at the SQL privilege layer as well as RLS. Supabase projects
-- created under the 2026 Data API defaults do not receive implicit table
-- grants, so this baseline states every schema/table/RPC capability explicitly.
-- Future objects inherit no Data API grants until a later reviewed migration
-- names the exact capability they require.
revoke all on schema public from public, anon, authenticated, service_role;
grant usage on schema public to authenticated, service_role;

alter default privileges in schema public
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema public
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

revoke all privileges on table
  public.profiles,
  public.workspaces,
  public.devices,
  public.vault_objects,
  public.vault_heads,
  public.vault_head_history,
  public.destructive_operation_requests
from public, anon, authenticated, service_role;

revoke all privileges on all sequences in schema public
from public, anon, authenticated, service_role;

grant select (
  workspace_id, signing_algorithm, signing_public_key, created_at
) on table public.workspaces to authenticated;
grant select (
  workspace_id, object_id, generation, envelope_version, ciphertext,
  ciphertext_sha256, signature, parent_object_id, parent_ciphertext_sha256,
  created_by_device_id, created_at
) on table public.vault_objects to authenticated;
grant select (
  workspace_id, object_id, generation, updated_at
) on table public.vault_heads to authenticated;
grant select (
  workspace_id, object_id, generation, committed_at
) on table public.vault_head_history to authenticated;

-- publish-vault-head performs these four bounded server-side reads before its
-- CAS RPC. Destructive-operation state remains reachable only through RPCs.
grant select (
  user_id, workspace_id, signing_algorithm, signing_public_key
) on table public.workspaces to service_role;
grant select (
  user_id, workspace_id, object_id, generation, envelope_version,
  ciphertext_sha256, signature, parent_object_id, parent_ciphertext_sha256
) on table public.vault_objects to service_role;
grant select (
  user_id, workspace_id, object_id, generation, updated_at
) on table public.vault_heads to service_role;

-- Authenticated clients receive SELECT plus three capability-gated RPCs. They
-- have no direct INSERT/UPDATE/DELETE grant on control-plane or vault tables.
revoke execute on all functions in schema public
from public, anon, authenticated, service_role;

revoke all on function public.rv_bootstrap_workspace(uuid, text, text, text, uuid) from public, anon;
revoke all on function public.rv_register_device(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) from public, anon;
revoke all on function public.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.rv_reject_immutable_update() from public, anon, authenticated;
revoke all on function public.rv_enforce_tenant_quota() from public, anon, authenticated;
revoke all on function public.rv_require_live_auth_session(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rv_current_session_is_live() from public, anon, authenticated, service_role;
revoke all on function public.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rv_mark_destructive_operation_completed(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rv_get_destructive_operation_status(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rv_prune_destructive_operation_requests() from public, anon, authenticated;
revoke all on function public.rv_prune_vault_objects() from public, anon, authenticated;

grant execute on function public.rv_bootstrap_workspace(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.rv_register_device(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid) to authenticated;
grant execute on function public.rv_current_session_is_live() to authenticated;
grant execute on function public.rv_service_publish_vault_head(uuid, uuid, uuid, bigint, uuid) to service_role;
grant execute on function public.rv_service_execute_workspace_deletion(uuid, uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.rv_service_execute_business_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.rv_begin_destructive_operation(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz) to service_role;
grant execute on function public.rv_mark_destructive_operation_deleting(uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.rv_mark_destructive_operation_completed(uuid, text, text, text, text) to service_role;
grant execute on function public.rv_get_destructive_operation_status(uuid, text, text, text, text) to service_role;
grant execute on function public.rv_prune_destructive_operation_requests() to service_role;
grant execute on function public.rv_prune_vault_objects() to service_role;

commit;

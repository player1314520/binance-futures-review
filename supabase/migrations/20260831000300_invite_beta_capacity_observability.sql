-- Invite Beta free-plan capacity and PII-free operations guard.
--
-- External usage is admitted only through an evidence-bound aggregate sample.
-- No tenant, user, connection, email, credential, or provider-event identity is
-- stored by this plane. Unknown or stale external usage fails closed for new
-- tenants and historical backfills; active-data deletion remains available.

begin;

do $preflight$
begin
  if to_regclass('public.rv2_tenants') is null
     or to_regclass('public.rv2_connections') is null
     or to_regclass('private.rv2_sync_jobs') is null
     or to_regclass('private.rv2_archive_jobs') is null
     or to_regprocedure('private.rv2_require_service_role()') is null then
    raise exception 'rv2 capacity guard requires the invite beta data plane'
      using errcode = 'P0001';
  end if;
end
$preflight$;

create table private.rv2_ops_capacity_observations (
  observation_id uuid not null default gen_random_uuid(),
  observed_at timestamptz not null,
  db_bytes bigint not null,
  r2_standard_bytes bigint not null,
  actions_minutes_used numeric(12, 3) not null,
  actions_minutes_limit numeric(12, 3) not null,
  backup_object_age_seconds bigint,
  smtp_delivery_failures_24h integer not null,
  evidence_sha256 text not null,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint rv2_ops_capacity_observations_pkey primary key (observation_id),
  constraint rv2_ops_capacity_observations_evidence_key unique (evidence_sha256),
  constraint rv2_ops_capacity_observations_time_check check (
    observed_at <= recorded_at + interval '5 minutes'
    and observed_at >= recorded_at - interval '24 hours'
  ),
  constraint rv2_ops_capacity_observations_db_check check (
    db_bytes between 0 and 10995116277760
  ),
  constraint rv2_ops_capacity_observations_r2_check check (
    r2_standard_bytes between 0 and 10995116277760
  ),
  constraint rv2_ops_capacity_observations_actions_check check (
    actions_minutes_used >= 0
    and actions_minutes_used <= 10000000
    and actions_minutes_limit > 0
    and actions_minutes_limit <= 10000000
  ),
  constraint rv2_ops_capacity_observations_backup_check check (
    backup_object_age_seconds is null
    or backup_object_age_seconds between 0 and 315576000
  ),
  constraint rv2_ops_capacity_observations_smtp_check check (
    smtp_delivery_failures_24h between 0 and 1000000
  ),
  constraint rv2_ops_capacity_observations_sha_check check (
    evidence_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create index rv2_ops_capacity_observations_time_idx
  on private.rv2_ops_capacity_observations (observed_at desc, observation_id);

create function private.rv2_ops_capacity_observation_immutable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'capacity observation is append-only' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger rv2_ops_capacity_observation_immutable
before update or delete on private.rv2_ops_capacity_observations
for each row execute function private.rv2_ops_capacity_observation_immutable();

create function private.rv2_ops_resource_state()
returns table (
  db_bytes bigint,
  r2_standard_bytes bigint,
  actions_minutes_used numeric,
  actions_minutes_limit numeric,
  backup_object_age_seconds bigint,
  smtp_delivery_failures_24h integer,
  observation_at timestamptz,
  external_usage_known boolean,
  admission_allowed boolean,
  history_allowed boolean,
  maintenance_read_only boolean,
  warning_codes text[]
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_db_bytes bigint := pg_database_size(current_database());
  v_observation record;
  v_external_usage_known boolean := false;
  v_admission_allowed boolean := false;
  v_history_allowed boolean := false;
  v_maintenance_read_only boolean;
  v_deletion_journal_objects_32d bigint := 0;
  v_warning_codes text[] := array[]::text[];
begin
  select o.* into v_observation
    from private.rv2_ops_capacity_observations as o
   order by o.observed_at desc, o.observation_id desc
   limit 1;

  v_external_usage_known := found
    and v_observation.observed_at >= statement_timestamp() - interval '24 hours';
  v_maintenance_read_only := v_db_bytes >= 419430400;

  -- R2 restore proofs begin one UTC day before a snapshot and backups live at
  -- most 30 days.  At 4,086 recent intents, stop admitting replacement Beta
  -- members and reserve the final ten object slots for the at-most-ten active
  -- accounts to execute one fail-closed DELETE_ACCOUNT each.
  select count(*) into v_deletion_journal_objects_32d
    from private.rv2_restore_v2_deletion_intents as intent
   where intent.created_at >= statement_timestamp() - interval '32 days';
  if v_deletion_journal_objects_32d >= 3276 then
    v_warning_codes := array_append(
      v_warning_codes, 'DELETION_JOURNAL_WINDOW_NEAR_LIMIT'
    );
  end if;

  if v_db_bytes >= 314572800 then
    v_warning_codes := array_append(v_warning_codes, 'DB_300_MIB_WARNING');
  end if;
  if v_db_bytes >= 367001600 then
    v_warning_codes := array_append(v_warning_codes, 'DB_350_MIB_ADMISSION_STOP');
  end if;
  if v_maintenance_read_only then
    v_warning_codes := array_append(v_warning_codes, 'DB_400_MIB_MAINTENANCE_READ_ONLY');
  end if;

  if not v_external_usage_known then
    v_warning_codes := array_append(v_warning_codes, 'EXTERNAL_USAGE_UNKNOWN_OR_STALE');
  else
    if v_observation.r2_standard_bytes >= 6442450944 then
      v_warning_codes := array_append(v_warning_codes, 'R2_60_PERCENT_WARNING');
    end if;
    if v_observation.r2_standard_bytes >= 8589934592 then
      v_warning_codes := array_append(v_warning_codes, 'R2_80_PERCENT_ADMISSION_STOP');
    end if;
    if v_observation.actions_minutes_used / v_observation.actions_minutes_limit >= 0.6 then
      v_warning_codes := array_append(v_warning_codes, 'ACTIONS_60_PERCENT_HISTORY_STOP');
    end if;
    if v_observation.backup_object_age_seconds is null
       or v_observation.backup_object_age_seconds > 86400 then
      v_warning_codes := array_append(v_warning_codes, 'BACKUP_OLDER_THAN_24H');
    end if;
    if v_observation.smtp_delivery_failures_24h > 0 then
      v_warning_codes := array_append(v_warning_codes, 'SMTP_DELIVERY_FAILURES');
    end if;
  end if;

  v_admission_allowed := v_db_bytes < 367001600
    and v_external_usage_known
    and v_observation.r2_standard_bytes < 8589934592
    and v_deletion_journal_objects_32d < 4086;
  v_history_allowed := v_admission_allowed
    and v_observation.actions_minutes_used / v_observation.actions_minutes_limit < 0.6;

  return query select
    v_db_bytes,
    case when v_external_usage_known then v_observation.r2_standard_bytes else null end,
    case when v_external_usage_known then v_observation.actions_minutes_used else null end,
    case when v_external_usage_known then v_observation.actions_minutes_limit else null end,
    case when v_external_usage_known then v_observation.backup_object_age_seconds else null end,
    case when v_external_usage_known then v_observation.smtp_delivery_failures_24h else null end,
    case when v_external_usage_known then v_observation.observed_at else null end,
    v_external_usage_known,
    v_admission_allowed,
    v_history_allowed,
    v_maintenance_read_only,
    v_warning_codes;
end
$function$;

create function public.rv2_service_record_capacity_observation(
  p_r2_standard_bytes bigint,
  p_actions_minutes_used numeric,
  p_actions_minutes_limit numeric,
  p_backup_object_age_seconds bigint,
  p_smtp_delivery_failures_24h integer,
  p_evidence_sha256 text,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_state record;
  v_expected_sha256 text;
  v_prior record;
begin
  perform private.rv2_require_service_role();
  if p_r2_standard_bytes is null
     or p_r2_standard_bytes < 0
     or p_r2_standard_bytes > 10995116277760
     or p_actions_minutes_used is null
     or p_actions_minutes_used < 0
     or p_actions_minutes_used > 10000000
     or p_actions_minutes_limit is null
     or p_actions_minutes_limit <= 0
     or p_actions_minutes_limit > 10000000
     or (p_backup_object_age_seconds is not null
         and p_backup_object_age_seconds not between 0 and 315576000)
     or p_smtp_delivery_failures_24h is null
     or p_smtp_delivery_failures_24h not between 0 and 1000000
     or p_evidence_sha256 is null
     or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
     or p_observed_at is null
     or p_observed_at < statement_timestamp() - interval '24 hours'
     or p_observed_at > statement_timestamp() + interval '5 minutes' then
    raise exception 'capacity observation rejected' using errcode = '22023';
  end if;

  v_expected_sha256 := encode(extensions.digest(convert_to(
    'rv-capacity-observation/1' || chr(0)
    || floor(extract(epoch from p_observed_at) * 1000)::bigint::text || chr(0)
    || p_r2_standard_bytes::text || chr(0)
    || round(p_actions_minutes_used * 1000)::bigint::text || chr(0)
    || round(p_actions_minutes_limit * 1000)::bigint::text || chr(0)
    || coalesce(p_backup_object_age_seconds::text, '-1') || chr(0)
    || p_smtp_delivery_failures_24h::text,
    'utf8'
  ), 'sha256'), 'hex');
  if v_expected_sha256 <> p_evidence_sha256 then
    raise exception 'capacity observation evidence mismatch' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'review-workbench-rv2-capacity:' || p_evidence_sha256,
    0
  ));
  select o.* into v_prior
    from private.rv2_ops_capacity_observations as o
   where o.evidence_sha256 = p_evidence_sha256;
  if found then
    if v_prior.observed_at <> p_observed_at
       or v_prior.r2_standard_bytes <> p_r2_standard_bytes
       or v_prior.actions_minutes_used <> p_actions_minutes_used
       or v_prior.actions_minutes_limit <> p_actions_minutes_limit
       or v_prior.backup_object_age_seconds is distinct from p_backup_object_age_seconds
       or v_prior.smtp_delivery_failures_24h <> p_smtp_delivery_failures_24h then
      raise exception 'idempotency evidence reused with different observation'
        using errcode = 'P0006';
    end if;
    select * into v_state from private.rv2_ops_resource_state();
    return jsonb_build_object(
      'format', 'rv-capacity-observation/1',
      'recorded', true,
      'replayed', true,
      'observedAt', v_state.observation_at,
      'externalUsageKnown', v_state.external_usage_known,
      'admissionAllowed', v_state.admission_allowed,
      'historyAllowed', v_state.history_allowed,
      'maintenanceReadOnly', v_state.maintenance_read_only,
      'warningCodes', to_jsonb(v_state.warning_codes)
    );
  end if;

  insert into private.rv2_ops_capacity_observations (
    observed_at, db_bytes, r2_standard_bytes,
    actions_minutes_used, actions_minutes_limit,
    backup_object_age_seconds, smtp_delivery_failures_24h, evidence_sha256
  ) values (
    p_observed_at, pg_database_size(current_database()), p_r2_standard_bytes,
    p_actions_minutes_used, p_actions_minutes_limit,
    p_backup_object_age_seconds, p_smtp_delivery_failures_24h, p_evidence_sha256
  );

  select * into v_state from private.rv2_ops_resource_state();
  return jsonb_build_object(
    'format', 'rv-capacity-observation/1',
    'recorded', true,
    'replayed', false,
    'observedAt', v_state.observation_at,
    'externalUsageKnown', v_state.external_usage_known,
    'admissionAllowed', v_state.admission_allowed,
    'historyAllowed', v_state.history_allowed,
    'maintenanceReadOnly', v_state.maintenance_read_only,
    'warningCodes', to_jsonb(v_state.warning_codes)
  );
end
$function$;

create function private.rv2_ops_enforce_resource_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_state record;
  v_guard text;
begin
  select * into v_state from private.rv2_ops_resource_state();

  if tg_table_name in ('rv2_tenants', 'rv2_memberships') and tg_op = 'INSERT' then
    v_guard := 'TENANT_ADMISSION';
    if not v_state.admission_allowed then
      raise exception 'resource guard unavailable' using errcode = '55000',
        detail = v_guard;
    end if;
  elsif tg_table_name = 'rv2_archive_jobs' and tg_op = 'INSERT' then
    v_guard := 'HISTORY_BACKFILL';
    if not v_state.history_allowed then
      raise exception 'resource guard unavailable' using errcode = '55000',
        detail = v_guard;
    end if;
  elsif tg_table_name = 'rv2_sync_jobs' and tg_op = 'INSERT' then
    if v_state.maintenance_read_only then
      raise exception 'resource guard unavailable' using errcode = '55000',
        detail = 'MAINTENANCE_WRITE';
    end if;
  elsif v_state.maintenance_read_only then
    -- Capacity pressure must never trap credentials or an account in an
    -- active state.  Permit only monotonic shutdown/revocation updates; all
    -- payload, ownership, generation, and ciphertext fields remain immutable.
    if tg_table_name = 'rv2_connections'
       and tg_op = 'UPDATE'
       and new.status in ('AUTH_ERROR', 'DISABLED', 'REVOKED')
       and (
         to_jsonb(new)
           - array['status', 'last_error_code', 'next_due_at', 'updated_at',
                   'disconnect_receipt_id', 'disconnected_at']
       ) = (
         to_jsonb(old)
           - array['status', 'last_error_code', 'next_due_at', 'updated_at',
                   'disconnect_receipt_id', 'disconnected_at']
       ) then
      return new;
    end if;
    if tg_table_name = 'rv2_credential_envelopes'
       and tg_op = 'UPDATE'
       and new.result_status = 'DISABLED'
       and new.retired_at is not null
       and (to_jsonb(new) - array['result_status', 'retired_at'])
         = (to_jsonb(old) - array['result_status', 'retired_at']) then
      return new;
    end if;
    if tg_table_name = 'rv2_memberships'
       and tg_op = 'UPDATE' then
      if new.status = 'REVOKED'
         and (to_jsonb(new) - array['status', 'updated_at'])
           = (to_jsonb(old) - array['status', 'updated_at']) then
        return new;
      end if;
      -- Maintenance pressure must not strand an account. Direct table access
      -- is revoked and forced RLS remains enabled; the transaction-local
      -- binding additionally proves the exact locked JOURNALED DELETE_ACCOUNT
      -- intent. Keep every other membership field immutable so this is not a
      -- general write bypass.
      if coalesce(auth.role(), '') = 'service_role'
         and old.status = 'ACTIVE'
         and new.status = 'DELETED'
         and new.membership_version = old.membership_version + 1
         and new.updated_at >= old.updated_at
         and current_setting(
           'review_workbench.rv2_journal_delete_intent', true
         ) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         and exists (
           select 1
             from private.rv2_restore_v2_deletion_intents as intent
            where intent.intent_id::text = current_setting(
              'review_workbench.rv2_journal_delete_intent', true
            )
              and intent.tenant_id = old.tenant_id
              and intent.subject_id = old.user_id
              and intent.operation = 'DELETE_ACCOUNT'
              and intent.state = 'JOURNALED'
         )
         and (to_jsonb(new) - array[
           'status', 'membership_version', 'updated_at'
         ]) = (to_jsonb(old) - array[
           'status', 'membership_version', 'updated_at'
         ]) then
        return new;
      end if;
    end if;
    v_guard := 'MAINTENANCE_WRITE';
    raise exception 'resource guard unavailable' using errcode = '55000',
      detail = v_guard;
  end if;

  return new;
end
$function$;

create trigger rv2_ops_tenant_admission_guard
before insert on public.rv2_tenants
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_membership_admission_guard
before insert on public.rv2_memberships
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_membership_write_guard
before update on public.rv2_memberships
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_archive_history_guard
before insert on private.rv2_archive_jobs
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_sync_write_guard
before insert on private.rv2_sync_jobs
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_connections_write_guard
before insert or update on public.rv2_connections
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_source_events_write_guard
before insert or update on public.rv2_source_events
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_generations_write_guard
before insert or update on public.rv2_generations
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_trade_identities_write_guard
before insert or update on public.rv2_trade_identities
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_trade_read_models_write_guard
before insert or update on public.rv2_trade_read_models
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_reviews_write_guard
before insert or update on public.rv2_reviews
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_actions_write_guard
before insert or update on public.rv2_actions
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_journal_write_guard
before insert or update on public.rv2_journal_entries
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_risk_write_guard
before insert or update on public.rv2_risk_rules
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_reports_write_guard
before insert or update on public.rv2_reports
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_ledger_write_guard
before insert or update on public.rv2_ledger_generations
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_reconciliation_write_guard
before insert or update on public.rv2_reconciliation_generations
for each row execute function private.rv2_ops_enforce_resource_guard();

-- At 400 MiB the active data plane must not keep growing through private
-- queues, coverage, conflict, or projection tables after public writes have
-- been stopped.  DELETE is deliberately not guarded so cleanup and account
-- deletion remain available under capacity pressure.  Backup evidence,
-- deletion tombstones, and worker-control records stay writable because they
-- are required to stop workers, prove deletion, and recover safely.
create trigger rv2_ops_credentials_write_guard
before insert or update on private.rv2_credential_envelopes
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_sync_attempts_write_guard
before insert or update on private.rv2_sync_attempts
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_sync_partitions_write_guard
before insert or update on private.rv2_sync_partitions
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_sync_coverage_write_guard
before insert or update on private.rv2_sync_coverage
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_source_conflicts_write_guard
before insert or update on private.rv2_source_event_conflicts
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_ledger_shadow_write_guard
before insert or update on private.rv2_ledger_shadow_submissions
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_post_commit_write_guard
before insert or update on private.rv2_post_commit_work
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_sync_gaps_write_guard
before insert or update on private.rv2_sync_gaps
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_archives_write_guard
before insert or update on private.rv2_archives
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_egress_receipts_write_guard
before insert or update on private.rv2_egress_receipts
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_review_requests_write_guard
before insert or update on private.rv2_review_requests
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_domain_requests_write_guard
before insert or update on private.rv2_domain_mutation_requests
for each row execute function private.rv2_ops_enforce_resource_guard();

create trigger rv2_ops_trade_projection_write_guard
before insert or update on private.rv2_trade_projection_evidence
for each row execute function private.rv2_ops_enforce_resource_guard();

create function public.rv2_service_get_operational_health()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_state record;
  v_queue_lag_seconds bigint;
  v_expired_leases bigint;
  v_rate_limit_429 bigint;
  v_ban_418 bigint;
  v_auth_failures bigint;
  v_open_gaps bigint;
  v_stale_coverage bigint;
begin
  perform private.rv2_require_service_role();
  select * into v_state from private.rv2_ops_resource_state();

  select coalesce(greatest(
           extract(epoch from statement_timestamp() - min(j.created_at))::bigint,
           0
         ), 0)
    into v_queue_lag_seconds
    from private.rv2_sync_jobs as j
   where j.status = 'QUEUED';

  select
    (select count(*) from private.rv2_sync_jobs as j
      where j.status = 'CLAIMED' and j.lease_expires_at < statement_timestamp())
    +
    (select count(*) from private.rv2_archive_jobs as a
      where a.status = 'CLAIMED' and a.lease_expires_at < statement_timestamp())
    into v_expired_leases;

  select count(*) into v_rate_limit_429
    from private.rv2_sync_attempts as a
   where a.claimed_at >= statement_timestamp() - interval '24 hours'
     and a.error_code in ('BINANCE_429', 'HTTP_429', 'RATE_LIMITED');

  select count(*) into v_ban_418
    from private.rv2_sync_attempts as a
   where a.claimed_at >= statement_timestamp() - interval '24 hours'
     and a.error_code in ('BINANCE_418', 'HTTP_418', 'IP_BANNED');

  select count(*) into v_auth_failures
    from public.rv2_connections as c
   where c.status = 'AUTH_ERROR';

  select count(*) into v_open_gaps
    from private.rv2_sync_gaps as g
   where g.status = 'OPEN';

  select count(*) into v_stale_coverage
    from private.rv2_sync_coverage as c
   where c.state = 'STALE';

  return jsonb_build_object(
    'format', 'rv-ops-health/1',
    'sampledAt', statement_timestamp(),
    'queueLagSeconds', v_queue_lag_seconds,
    'expiredLeases', v_expired_leases,
    'rateLimit429Last24h', v_rate_limit_429,
    'ban418Last24h', v_ban_418,
    'authFailures', v_auth_failures,
    'openCoverageGaps', v_open_gaps,
    'staleCoveragePartitions', v_stale_coverage,
    'dbBytes', v_state.db_bytes,
    'r2StandardBytes', v_state.r2_standard_bytes,
    'backupObjectAgeSeconds', v_state.backup_object_age_seconds,
    'smtpDeliveryFailures24h', v_state.smtp_delivery_failures_24h,
    'actionsMinutesUsed', v_state.actions_minutes_used,
    'actionsMinutesLimit', v_state.actions_minutes_limit,
    'externalUsageKnown', v_state.external_usage_known,
    'admissionAllowed', v_state.admission_allowed,
    'historyAllowed', v_state.history_allowed,
    'maintenanceReadOnly', v_state.maintenance_read_only,
    'warningCodes', to_jsonb(v_state.warning_codes)
  );
end
$function$;

alter table private.rv2_ops_capacity_observations enable row level security;
alter table private.rv2_ops_capacity_observations force row level security;

revoke all privileges on table private.rv2_ops_capacity_observations from public, anon, authenticated, service_role;
revoke execute on function private.rv2_ops_capacity_observation_immutable()
  from public, anon, authenticated, service_role;
revoke execute on function private.rv2_ops_resource_state()
  from public, anon, authenticated, service_role;
revoke execute on function private.rv2_ops_enforce_resource_guard()
  from public, anon, authenticated, service_role;

revoke execute on function public.rv2_service_record_capacity_observation(
  bigint, numeric, numeric, bigint, integer, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.rv2_service_record_capacity_observation(
  bigint, numeric, numeric, bigint, integer, text, timestamptz
) to service_role;

revoke execute on function public.rv2_service_get_operational_health()
  from public, anon, authenticated, service_role;
grant execute on function public.rv2_service_get_operational_health()
  to service_role;

commit;

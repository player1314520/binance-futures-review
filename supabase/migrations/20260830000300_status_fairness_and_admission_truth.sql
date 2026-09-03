begin;

-- A shared anonymous bucket must not let random capabilities starve recovery
-- for a capability that actually exists. Resolve the keyed status row first:
-- known capabilities use only their own 10/minute bucket; unknown probes share
-- the 60/minute global bucket and still receive the same zero-row response.
create or replace function public.rv_get_destructive_operation_status(
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
  v_request_id uuid;
  v_operation text;
  v_status text;
  v_receipt_id uuid;
  v_expires_at timestamptz;
  v_known boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select core.request_id, core.operation, core.status, core.receipt_id, core.expires_at
    into v_request_id, v_operation, v_status, v_receipt_id, v_expires_at
    from private.rv_core_get_destructive_operation_status(
      p_request_id,
      p_capability_fingerprint,
      p_subject_fingerprint,
      p_scope_fingerprint,
      p_operation
    ) as core;
  v_known := found;

  if v_known then
    perform private.rv_consume_rate_limit(
      'deletion-status',
      'capability',
      private.rv_rate_limit_fingerprint(
        'deletion-status-capability',
        coalesce(p_capability_fingerprint, '')
      )
    );
  else
    perform private.rv_consume_rate_limit(
      'deletion-status-global',
      'global',
      private.rv_rate_limit_fingerprint('deletion-status-global-unknown', 'all')
    );
  end if;

  perform private.rv_acquire_user_database_slot();
  if v_known then
    return query select
      v_request_id, v_operation, v_status, v_receipt_id, v_expires_at;
  end if;
  return;
end
$function$;

alter function public.rv_get_destructive_operation_status(uuid, text, text, text, text)
  owner to postgres;
revoke all on function public.rv_get_destructive_operation_status(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.rv_get_destructive_operation_status(uuid, text, text, text, text)
  to service_role;

comment on function public.rv_get_destructive_operation_status(uuid, text, text, text, text) is
  'Service-only non-enumerating status lookup: known capabilities have isolated 10/min buckets; unknown probes share 60/min without starving known recovery.';
comment on function private.rv_consume_rate_limit(text, text, text) is
  'Transactional token consumption. A statement that raises later rolls its charge back; evidence must describe this as committed-statement throughput control, not all-attempt or Edge/IP limiting.';

commit;

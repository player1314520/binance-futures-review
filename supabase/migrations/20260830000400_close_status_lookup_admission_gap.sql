begin;

-- Bound every status lookup before it touches destructive-operation state.
-- The semaphore limits concurrent database work to ten transactions. The
-- post-lookup buckets preserve recovery fairness: a known capability has an
-- isolated 10/minute bucket, while unknown probes share 60/minute. Because
-- PostgreSQL rolls back a token change when a later statement raises, these
-- buckets describe committed-statement throughput, not Edge, IP, or all-attempt
-- ingress limiting.
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

  perform private.rv_acquire_user_database_slot();

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
  'Service-only non-enumerating status lookup: ten-slot database admission precedes state access; known capabilities have isolated 10/min committed-statement buckets; unknown probes share 60/min.';

commit;

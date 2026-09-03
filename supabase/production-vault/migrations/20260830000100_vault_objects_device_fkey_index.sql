-- Forward-only production follow-up for the isolated Review Workbench vault.
-- The composite order matches vault_objects_device_fkey and keeps tenant and
-- workspace isolation as the leading columns for device-reference checks.

begin;

create index vault_objects_device_fkey_idx
  on public.vault_objects (user_id, workspace_id, created_by_device_id);

commit;

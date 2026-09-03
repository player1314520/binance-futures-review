import { productionLiveContractSha256 } from './production-live-contract.mjs';

export const INVITE_BETA_CONTRACT_DOMAIN = 'rv-invite-beta-contract/1';

// Keep this list explicit.  The build must never silently accept an unreviewed
// runtime file merely because it appeared in a directory.
export const INVITE_BETA_CONTRACT_FILES = Object.freeze([
  'app/invite-beta-attestation.mjs',
  'app/invite-beta-contract.mjs',
  'app/src/lib/binance-source.ts',
  'app/src/lib/cloud-beta-client.ts',
  'app/src/lib/cloud-beta-connection.ts',
  'app/src/lib/cloud-beta-contract.ts',
  'app/src/lib/release-config.ts',
  'app/vite.config.ts',
  'supabase/config.toml',
  'supabase/functions/beta-operations/core.mjs',
  'supabase/functions/beta-operations/handler.mjs',
  'supabase/functions/beta-operations/index.ts',
  'supabase/functions/beta-operations/runtime.mjs',
  'supabase/functions/binance-beta/archive.mjs',
  'supabase/functions/binance-beta/binance-client.mjs',
  'supabase/functions/binance-beta/crypto.mjs',
  'supabase/functions/binance-beta/handler.mjs',
  'supabase/functions/binance-beta/index.ts',
  'supabase/functions/binance-beta/internal-handler.mjs',
  'supabase/functions/binance-beta/ledger.mjs',
  'supabase/functions/binance-beta/runtime.mjs',
  'supabase/functions/binance-beta/trade-projector.mjs',
  'supabase/functions/restore-v2/core.mjs',
  'supabase/functions/restore-v2/handler.mjs',
  'supabase/functions/restore-v2/index.ts',
  'supabase/functions/restore-v2/runtime.mjs',
  'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  'supabase/migrations/20260831000200_restore_v2_lineage.sql',
  'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
]);

export const INVITE_BETA_CONTRACT_SOURCE_OVERRIDES = Object.freeze({
  'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql':
    'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  'supabase/migrations/20260831000200_restore_v2_lineage.sql':
    'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
  'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql':
    'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
});

export function inviteBetaContractSha256({ repositoryRoot }) {
  return productionLiveContractSha256({
    repositoryRoot,
    domain: INVITE_BETA_CONTRACT_DOMAIN,
    relativePaths: INVITE_BETA_CONTRACT_FILES,
    sourceOverrides: INVITE_BETA_CONTRACT_SOURCE_OVERRIDES,
  });
}

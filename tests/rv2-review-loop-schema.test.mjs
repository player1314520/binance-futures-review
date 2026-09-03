import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

function tableBody(schema, name) {
  const match = sql.match(new RegExp(
    `create table ${schema}\\.${name} \\(([\\s\\S]*?)\\n\\);`,
    'i',
  ));
  assert.ok(match, `missing table ${schema}.${name}`);
  return match[1];
}

function functionBody(name, schema = 'public') {
  const match = sql.match(new RegExp(
    `create(?: or replace)? function ${schema}\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`,
    'i',
  ));
  assert.ok(match, `missing RPC public.${name}`);
  return match[0];
}

test('trusted trade identities and generation read models are composite tenant resources', () => {
  const identities = tableBody('public', 'rv2_trade_identities');
  const models = tableBody('public', 'rv2_trade_read_models');
  assert.match(identities, /primary key \(tenant_id, connection_id, trade_id\)/i);
  assert.match(
    identities,
    /unique \(tenant_id, connection_id, trade_id, source_lineage_sha256\)/i,
  );
  assert.match(identities, /trade_id ~ '\^t_\[0-9a-f\]\{16\}\$'/i);
  assert.match(identities, /source_lineage_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(identities, /first_generation bigint not null/i);
  assert.match(models, /primary key \(tenant_id, connection_id, trade_id, generation\)/i);
  assert.match(models, /foreign key \(tenant_id, connection_id, trade_id\)[\s\S]*rv2_trade_identities/i);
  assert.match(models, /foreign key \(tenant_id, connection_id, generation\)[\s\S]*rv2_generations/i);
  assert.match(models, /payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
});

test('review and action ownership cannot escape the composite trade and review identity', () => {
  const reviews = tableBody('public', 'rv2_reviews');
  const actions = tableBody('public', 'rv2_actions');
  const requests = tableBody('private', 'rv2_review_requests');
  assert.match(reviews, /trade_generation bigint not null/i);
  assert.match(reviews, /source_lineage_sha256 text not null/i);
  assert.match(reviews, /unique \(tenant_id, connection_id, review_id\)/i);
  assert.match(reviews, /unique \(tenant_id, connection_id, review_id, trade_id\)/i);
  assert.match(reviews, /foreign key \(tenant_id, connection_id, trade_id, trade_generation\)[\s\S]*rv2_trade_read_models/i);
  assert.match(
    reviews,
    /foreign key \(tenant_id, connection_id, trade_id, source_lineage_sha256\)[\s\S]*rv2_trade_identities/i,
  );
  assert.match(actions, /trade_id text not null/i);
  assert.match(actions, /foreign key \(tenant_id, connection_id, trade_id\)[\s\S]*rv2_trade_identities/i);
  assert.match(
    actions,
    /foreign key \(tenant_id, connection_id, review_id, trade_id\)[\s\S]*rv2_reviews/i,
  );
  assert.match(
    requests,
    /foreign key \(tenant_id, connection_id, review_id, trade_id\)[\s\S]*rv2_reviews/i,
  );
  assert.doesNotMatch(actions, /foreign key \(review_id\)/i);
  assert.doesNotMatch(requests, /foreign key \(review_id\)/i);
});

test('authoritative projection is generation-bound, replay-safe, and atomic with publish', () => {
  const evidence = tableBody('private', 'rv2_trade_projection_evidence');
  assert.match(evidence, /primary key \(tenant_id, connection_id, generation\)/i);
  assert.match(evidence, /projection_sha256 text not null/i);
  const fn = functionBody('rv2_project_trade_read_models', 'private');
  assert.match(fn, /p_generation bigint/i);
  assert.match(fn, /p_published_at timestamptz/i);
  assert.match(fn, /e\.dataset = 'fills'/i);
  assert.match(fn, /e\.source_observed_at <= p_published_at/i);
  assert.match(fn, /rv2-trade-id\/1/i);
  assert.match(fn, /rv2-trade-read-model\/1/i);
  assert.match(fn, /trade identity conflict/i);
  assert.match(fn, /trade read model conflict/i);
  assert.doesNotMatch(fn, /update public\.rv2_generations|update public\.rv2_connections|capabilit/i);
  const publish = functionBody('rv2_service_publish_generation');
  assert.match(publish, /insert into public\.rv2_generations[\s\S]*private\.rv2_project_trade_read_models[\s\S]*update public\.rv2_connections/i);
  assert.match(publish, /v_trade_model_count > 0 then 'LIMITED'/i);
  assert.match(publish, /'recordsBrowsable'[\s\S]*'TRUSTED_RECORDS_ONLY'/i);
  assert.match(publish, /'observedTradeAnalytics'[\s\S]*'DENY'/i);
  const generationInsert = publish.indexOf('insert into public.rv2_generations');
  const projection = publish.indexOf('private.rv2_project_trade_read_models');
  const reconciliation = publish.indexOf('insert into public.rv2_reconciliation_generations');
  const currentCas = publish.indexOf('update public.rv2_connections');
  assert.ok(generationInsert >= 0 && generationInsert < projection);
  assert.ok(projection < reconciliation && reconciliation < currentCas);
  assert.doesNotMatch(publish, /(?:^|;)\s*(?:commit|rollback)\b/im);
});

test('SQL projector keeps the exact-decimal and Hedge Mode parity invariants used by JS fixtures', () => {
  const canonicalDecimal = functionBody('rv2_canonical_trade_decimal', 'private');
  const projector = functionBody('rv2_project_trade_read_models', 'private');
  assert.match(canonicalDecimal, /round\(p_value, 18\)/i);
  assert.match(projector, /\(e\.event_body ->> 'qty'\)::numeric/i);
  assert.match(projector, /v_closes_exactly := v_current_qty = v_fill\.qty/i);
  assert.doesNotMatch(projector, /epsilon|float|double precision|real\b/i);
  assert.match(projector, /v_crosses_zero and v_book\.position_side <> 'BOTH'/i);
  assert.match(projector, /v_book\.position_side = 'LONG' and v_direction <> 1/i);
  assert.match(projector, /v_book\.position_side = 'SHORT' and v_direction <> -1/i);
  assert.match(projector, /provider_event_id <> 'binance-usdm:fills:'/i);
  assert.match(projector, /realizedPnlAsset'\) = 'USDT'/i);
  assert.match(projector, /realizedPnlAsset'\) = 'USDC'/i);
  assert.match(projector, /jsonb_each_text\(v_commissions\)/i);
});

test('browser review validates the current server trade model and all domain writes use CAS idempotency', () => {
  const review = functionBody('rv2_upsert_review');
  assert.match(review, /rv2_trade_read_models/i);
  assert.match(review, /v_connection\.current_generation/i);
  assert.match(review, /source_lineage_sha256/i);
  assert.doesNotMatch(review, /e\.event_body ->> 'id' = p_trade_id/i);
  assert.ok(
    review.indexOf('from private.rv2_review_requests')
      < review.indexOf('from public.rv2_connections'),
    'idempotency receipt must replay before current generation/model validation',
  );
  assert.doesNotMatch(
    review.match(/v_request_fingerprint :=[\s\S]*?perform pg_advisory_xact_lock/i)?.[0] ?? '',
    /current_generation|source_lineage_sha256/i,
  );
  for (const name of [
    'rv2_upsert_action',
    'rv2_upsert_journal',
    'rv2_upsert_risk_rule',
    'rv2_upsert_report',
  ]) {
    const body = functionBody(name);
    assert.match(body, /p_expected_version bigint/i);
    assert.match(body, /p_idempotency_key uuid/i);
    assert.match(body, /rv2_domain_mutation_requests/i);
    assert.match(body, /request_fingerprint/i);
    assert.match(body, /40001/i);
    assert.ok(
      body.indexOf('from private.rv2_domain_mutation_requests')
        < body.search(/from public\.rv2_(?:reviews|connections|generations)/i),
      `${name} must replay a committed receipt before mutable resource state checks`,
    );
  }
  const action = functionBody('rv2_upsert_action');
  assert.match(action, /p_payload -> 'experiment' is distinct from v_action\.payload -> 'experiment'/i);
  assert.match(action, /g\.capabilities -> 'experiments' ->> 'decision' = 'ALLOW'/i);
  assert.match(action, /action experiment unavailable/i);
});

test('cloud dataset returns trusted trade models plus every relational review-loop collection', () => {
  const dataset = functionBody('rv2_get_current_dataset');
  assert.match(dataset, /rv2_trade_read_models/i);
  for (const key of ['tradeModels', 'reviews', 'actions', 'journal', 'risk', 'reports']) {
    assert.match(dataset, new RegExp(`'${key}'`, 'i'));
  }
  assert.match(dataset, /'reviewId', r\.review_id/i);
  assert.match(dataset, /'tradeId', a\.trade_id/i);
  assert.match(dataset, /m\.generation = v_connection\.current_generation/i);
  assert.match(dataset, /r\.source_lineage_sha256 = i\.source_lineage_sha256/i);
  assert.match(dataset, /join public\.rv2_reviews as r[\s\S]*a\.review_id/i);
});

test('trade/domain relations are forced-RLS RPC-only and browser grants are narrow', () => {
  for (const [schema, name] of [
    ['public', 'rv2_trade_identities'],
    ['public', 'rv2_trade_read_models'],
    ['private', 'rv2_domain_mutation_requests'],
    ['private', 'rv2_trade_projection_evidence'],
  ]) {
    assert.match(sql, new RegExp(`alter table ${schema}\\.${name} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table ${schema}\\.${name} force row level security;`, 'i'));
    assert.match(sql, new RegExp(
      `revoke all privileges on table ${schema}\\.${name} from public, anon, authenticated, service_role;`,
      'i',
    ));
  }
  for (const name of ['rv2_upsert_action', 'rv2_upsert_journal', 'rv2_upsert_risk_rule', 'rv2_upsert_report']) {
    assert.match(sql, new RegExp(
      `revoke all on function public\\.${name}\\([^;]*\\) from public, anon, authenticated, service_role;`,
      'i',
    ));
    assert.match(sql, new RegExp(
      `grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`,
      'i',
    ));
    assert.doesNotMatch(sql, new RegExp(
      `grant execute on function public\\.${name}\\([^;]*\\) to (?:anon|service_role|public);`,
      'i',
    ));
  }
});

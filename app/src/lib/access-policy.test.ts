import { describe, expect, it } from 'vitest';
import { resolveBinanceAccess } from './access-policy';

function bundle(overrides: Record<string, unknown> = {}) {
  const base = {
    fills: [{ id: '1' }],
    _meta: {
      dataStatus: 'CURRENT',
      quality: {
        status: 'PARTIAL',
        accountScope: 'BOUND',
        capabilities: {
          recordsBrowsable: { decision: 'LIMITED', reasonCodes: ['QUALITY_PARTIAL'] },
          observedTradeAnalytics: { decision: 'LIMITED', reasonCodes: ['QUALITY_PARTIAL'] },
          accountKpis: { decision: 'DENY', reasonCodes: ['ACCOUNT_KPIS_UNPROVEN'] },
          currentPositions: { decision: 'DENY', reasonCodes: ['POSITIONS_UNPROVEN'] },
          equityAnalytics: { decision: 'DENY', reasonCodes: ['EQUITY_UNPROVEN'] },
          ledger: { decision: 'DENY', reasonCodes: ['LEDGER_NOT_IMPLEMENTED'] },
        },
        reasonCodes: [],
      },
    },
    reconciliation: { protocol: 'rv-reconciliation/2', status: 'PASS', reasonCodes: [] },
  };
  return { ...base, ...overrides };
}

describe('Binance review assistant access policy', () => {
  it('unlocks only observed trade analytics after exact reconciliation PASS', () => {
    const access = resolveBinanceAccess(bundle());

    expect(access.phase).toBe('BINANCE_OBSERVED_READY');
    expect(access.showObservedAnalytics).toBe(true);
    expect(access.showAccountKpis).toBe(false);
    expect(access.showEquity).toBe(false);
    expect(access.showLedger).toBe(false);
  });

  for (const status of ['UNKNOWN', 'PARTIAL', 'FAIL']) {
    it(`keeps analytics locked when reconciliation is ${status}`, () => {
      const access = resolveBinanceAccess(bundle({
        reconciliation: { status, reasonCodes: [`RECONCILIATION_${status}`] },
      }));

      expect(access.phase).toBe('BINANCE_BROWSE_ONLY');
      expect(access.showRecords).toBe(true);
      expect(access.showObservedAnalytics).toBe(false);
      expect(access.reasonCodes).toContain(`RECONCILIATION_${status}`);
    });
  }

  it('keeps analytics locked when reconciliation evidence is missing', () => {
    const candidate = bundle() as any;
    delete (candidate as { reconciliation?: unknown }).reconciliation;
    const access = resolveBinanceAccess(candidate);

    expect(access.phase).toBe('BINANCE_BROWSE_ONLY');
    expect(access.reasonCodes).toContain('RECONCILIATION_REQUIRED');
  });

  it('blocks stale and legacy-unbound sources from observed analytics', () => {
    for (const dataStatus of ['CACHED_ONLY', 'LEGACY_UNBOUND']) {
      const access = resolveBinanceAccess(bundle({
        _meta: {
          ...(bundle()._meta as Record<string, unknown>),
          dataStatus,
        },
      }));
      expect(access.phase).toBe('BINANCE_BROWSE_ONLY');
      expect(access.showObservedAnalytics).toBe(false);
    }

  });

  it('does not unlock on a legacy v1 PASS', () => {
    const access = resolveBinanceAccess(bundle({
      reconciliation: {
        protocol: 'rv-reconciliation/1',
        status: 'PASS',
        reasonCodes: [],
      },
    }));

    expect(access.phase).toBe('BINANCE_BROWSE_ONLY');
    expect(access.showObservedAnalytics).toBe(false);
    expect(access.reasonCodes).toContain('RECONCILIATION_V2_REQUIRED');
  });

  it('fails closed when records are denied', () => {
    const candidate = bundle() as any;
    candidate._meta.quality.capabilities.recordsBrowsable = {
      decision: 'DENY',
      reasonCodes: ['ACCOUNT_SCOPE_UNVERIFIED'],
    };
    const access = resolveBinanceAccess(candidate);

    expect(access.phase).toBe('BINANCE_BLOCKED');
    expect(access.showRecords).toBe(false);
    expect(access.showObservedAnalytics).toBe(false);
    expect(access.reasonCodes).toContain('ACCOUNT_SCOPE_UNVERIFIED');
  });

  it('reports a truthful empty state without unlocking analytics', () => {
    const candidate = bundle({ fills: [] });
    const access = resolveBinanceAccess(candidate);

    expect(access.phase).toBe('BINANCE_EMPTY');
    expect(access.showRecords).toBe(true);
    expect(access.showObservedAnalytics).toBe(false);
  });
});

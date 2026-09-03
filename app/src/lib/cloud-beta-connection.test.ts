import { describe, expect, it } from 'vitest';
import {
  normalizeCloudConnectionMutation,
  normalizeCloudConnectionStatus,
  normalizeCloudConnections,
  normalizeCloudDisconnect,
} from './cloud-beta-connection';

const CONNECTION_ID = '018f47a2-4bb0-7ee0-8000-0123456789ab';
const CHECKED_AT = '2026-08-31T01:00:00.000Z';

function permissionEvidence() {
  return {
    evidenceVersion: 'rv-binance-permission/1',
    provider: 'binance-usdm',
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
    checkedAt: CHECKED_AT,
    evidenceDigest: 'a'.repeat(64),
  };
}

function connection() {
  return {
    connectionId: CONNECTION_ID,
    status: 'ACTIVE',
    credentialVersion: 3,
    lastTrustedAt: CHECKED_AT,
    nextDueAt: '2026-08-31T02:00:00.000Z',
    permissionEvidence: permissionEvidence(),
  };
}

describe('invite beta connection envelopes', () => {
  it('normalizes the exact list envelope and freezes its audit evidence', () => {
    const result = normalizeCloudConnections({
      format: 'rv-binance-connections/1',
      connections: [connection()],
    });

    expect(result.connections).toEqual([connection()]);
    expect(Object.isFrozen(result.connections[0].permissionEvidence)).toBe(true);
  });

  it('allows pending connections to have no completed permission evidence', () => {
    const pending = { ...connection(), status: 'PENDING', permissionEvidence: null };
    expect(normalizeCloudConnections({
      format: 'rv-binance-connections/1',
      connections: [pending],
    }).connections[0].permissionEvidence).toBeNull();
  });

  it('requires every ACTIVE connection to carry affirmative read-only evidence', () => {
    const unsafe = connection();
    unsafe.permissionEvidence.tradeDisabled = false;
    expect(() => normalizeCloudConnections({
      format: 'rv-binance-connections/1',
      connections: [unsafe],
    })).toThrow(/CLOUD_CONNECTION_INVALID/);
  });

  it('normalizes the create/rotate response without accepting an extra envelope field', () => {
    const response = {
      connectionId: CONNECTION_ID,
      status: 'ACTIVE',
      credentialVersion: 4,
      permissionEvidence: permissionEvidence(),
    };
    expect(normalizeCloudConnectionMutation(response)).toEqual(response);
    expect(() => normalizeCloudConnectionMutation({
      ...response,
      format: 'rv-binance-connection/1',
    })).toThrow(/CLOUD_CONNECTION_INVALID/);
  });

  it('normalizes exact per-partition status without exposing raw provider errors', () => {
    const response = {
      format: 'rv-binance-connection-status/1',
      connection: connection(),
      coverage: [{
        dataset: 'trades',
        partitionKey: 'BTCUSDT',
        coverageState: 'PARTIAL',
        attemptedThrough: CHECKED_AT,
        fetchedThrough: '2026-08-31T00:59:00.000Z',
        committedThrough: '2026-08-31T00:58:00.000Z',
        trustedThrough: '2026-08-31T00:57:00.000Z',
        openGapCount: 1,
        currentGeneration: 7,
        reconciliationStatus: 'unknown',
        lastErrorCode: 'BINANCE_WINDOW_GAP',
      }],
      lastErrorCode: 'SYNC_PARTIAL',
    };
    expect(normalizeCloudConnectionStatus(response)).toEqual(response);

    const leaked = structuredClone(response) as typeof response & { errorMessage?: string };
    leaked.errorMessage = 'provider stack must never cross the boundary';
    expect(() => normalizeCloudConnectionStatus(leaked)).toThrow(/CLOUD_CONNECTION_INVALID/);
  });

  it('normalizes the exact disconnect receipt', () => {
    expect(normalizeCloudDisconnect({
      status: 'DISCONNECTED',
      receiptId: '018f47a2-4bb0-7ee0-8000-abcdefabcdef',
    })).toEqual({
      status: 'DISCONNECTED',
      receiptId: '018f47a2-4bb0-7ee0-8000-abcdefabcdef',
    });
  });

  it.each([
    { format: 'rv-binance-connections/0', connections: [] },
    { format: 'rv-binance-connections/1', connections: [], extra: true },
    { format: 'rv-binance-connections/1', connections: [{ ...connection(), credentialVersion: 0 }] },
    { format: 'rv-binance-connections/1', connections: [{ ...connection(), connectionId: 'not-a-uuid' }] },
  ])('rejects a non-canonical list response: %o', (input) => {
    expect(() => normalizeCloudConnections(input)).toThrow(/CLOUD_CONNECTION_INVALID/);
  });
});

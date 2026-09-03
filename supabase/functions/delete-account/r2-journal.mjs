const PREFIX = 'deletion-journal/v2/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_KEY = /^deletion-journal\/v2\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]json$/u;
const encoder = new TextEncoder();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateEvent(event) {
  invariant(exact(event, ['committedAt', 'eventId', 'format', 'operation', 'tenantLineageId'])
    && event.format === 'rv-deletion-journal-event/2'
    && UUID.test(event.eventId ?? '')
    && UUID.test(event.tenantLineageId ?? '')
    && ['DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT'].includes(event.operation),
  'deletion journal event invalid');
  const committedAt = Date.parse(event.committedAt);
  invariant(Number.isFinite(committedAt)
    && new Date(committedAt).toISOString() === event.committedAt,
  'deletion journal event time invalid');
  return event;
}

function keyFor(event) {
  return `${PREFIX}${event.committedAt.slice(0, 10).replaceAll('-', '/')}/${event.eventId}.json`;
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function normalizedHeaderValue(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !/[\r\n]/u.test(value), 'R2 request header invalid');
  return value.trim().replace(/[ \t]+/gu, ' ');
}

async function signedR2Request({
  accountId,
  bucket,
  credentials,
  method,
  objectKey = null,
  query = [],
  headers = {},
  body = new Uint8Array(),
  now,
}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${awsEncode(bucket)}${objectKey === null
    ? ''
    : `/${objectKey.split('/').map(awsEncode).join('/')}`}`;
  const canonicalQuery = query.map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ))
    .map(([key, value]) => `${key}=${value}`).join('&');
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const date = timestamp.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const signed = new Map(Object.entries({
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
    'x-amz-security-token': credentials.sessionToken,
    ...Object.fromEntries(Object.entries(headers).map(([key, value]) => (
      [key.toLowerCase(), normalizedHeaderValue(value)]
    ))),
  }));
  const names = [...signed.keys()].sort();
  const canonicalHeaders = `${names.map(name => `${name}:${signed.get(name)}`).join('\n')}\n`;
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const credentialScope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', timestamp, credentialScope, await sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = await hmacSha256(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  const kRegion = await hmacSha256(kDate, 'auto');
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = [...await hmacSha256(kSigning, stringToSign)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const requestHeaders = Object.fromEntries([...signed.entries()].filter(([name]) => name !== 'host'));
  requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Object.freeze({
    url: `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    init: Object.freeze({
      method,
      headers: Object.freeze(requestHeaders),
      body: method === 'PUT' ? body : undefined,
    }),
  });
}

async function boundedBytes(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  invariant(!Number.isFinite(declared) || declared <= maximum, 'provider response too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  invariant(bytes.byteLength <= maximum, 'provider response too large');
  return bytes;
}

async function boundedJson(response, maximum = 64 * 1024) {
  const bytes = await boundedBytes(response, maximum);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new Error('provider response invalid');
  }
  invariant(response.ok, 'provider request unavailable');
  return value;
}

function xmlText(value) {
  invariant(typeof value === 'string' && !/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value),
    'R2 list XML invalid');
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'");
}

function oneTag(xml, name, required = true) {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([^<]*)<\\/${name}>`, 'gu'))];
  invariant((required && matches.length === 1) || (!required && matches.length <= 1),
    'R2 list XML invalid');
  return matches.length === 0 ? null : xmlText(matches[0][1]);
}

function parseListXml(bytes) {
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new Error('R2 list XML invalid');
  }
  invariant(/<ListBucketResult(?:\s|>)/u.test(xml), 'R2 list XML invalid');
  const truncatedText = oneTag(xml, 'IsTruncated');
  invariant(truncatedText === 'true' || truncatedText === 'false', 'R2 list XML invalid');
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/gu)].map(match => {
    let key;
    try { key = decodeURIComponent(xmlText(match[1])); } catch { throw new Error('R2 list key invalid'); }
    invariant(OBJECT_KEY.test(key), 'R2 list key invalid');
    return key;
  });
  const token = oneTag(xml, 'NextContinuationToken', false);
  invariant(truncatedText === 'false' || (token && token.length <= 4096 && !/[\r\n]/u.test(token)),
    'R2 list continuation invalid');
  return Object.freeze({ truncated: truncatedText === 'true', keys, continuationToken: token });
}

function evidenceRoot(entries) {
  return sha256Hex(encoder.encode('rv-deletion-journal-list/2\0' + entries.map(entry => (
    `${entry.key}\0${entry.sha256}\0${entry.bytes}\n`
  )).join('')));
}

export function createEdgeDeletionJournal({
  accountId,
  apiToken,
  parentAccessKeyId,
  bucket,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  invariant(/^[a-f0-9]{32}$/u.test(accountId ?? ''), 'Cloudflare account invalid');
  invariant(typeof apiToken === 'string' && /^\S{32,8192}$/u.test(apiToken),
    'Cloudflare API token invalid');
  invariant(/^[A-Za-z0-9_-]{8,128}$/u.test(parentAccessKeyId ?? ''),
    'R2 parent access key invalid');
  invariant(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket ?? '')
    && !bucket.includes('..'), 'R2 bucket invalid');
  invariant(typeof fetchImpl === 'function' && typeof now === 'function', 'R2 runtime invalid');

  async function cloudflare(path, method, json, signal) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${apiToken}`,
        accept: 'application/json',
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const value = await boundedJson(response);
    invariant(value?.success === true && value.result && typeof value.result === 'object',
      'Cloudflare response invalid');
    return value.result;
  }

  async function privateAccessAndCredentials(signal) {
    const encodedBucket = encodeURIComponent(bucket);
    const [managed, custom] = await Promise.all([
      cloudflare(`/r2/buckets/${encodedBucket}/domains/managed`, 'GET', undefined, signal),
      cloudflare(`/r2/buckets/${encodedBucket}/domains/custom`, 'GET', undefined, signal),
    ]);
    invariant(managed.enabled === false && Array.isArray(custom.domains)
      && custom.domains.length === 0, 'R2 private access cannot be proven');
    const credentials = await cloudflare('/r2/temp-access-credentials', 'POST', {
      bucket,
      parentAccessKeyId,
      permission: 'object-read-write',
      prefixes: [PREFIX],
      ttlSeconds: 120,
    }, signal);
    invariant(/^[A-Za-z0-9_-]{8,128}$/u.test(credentials.accessKeyId ?? '')
      && /^\S{16,512}$/u.test(credentials.secretAccessKey ?? '')
      && /^\S{16,8192}$/u.test(credentials.sessionToken ?? ''),
    'temporary R2 credentials invalid');
    return Object.freeze({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    });
  }

  async function r2(credentials, request, signal) {
    const built = await signedR2Request({
      accountId, bucket, credentials, now: now(), ...request,
    });
    return fetchImpl(built.url, { ...built.init, signal, redirect: 'error' });
  }

  async function head(credentials, key, signal) {
    invariant(OBJECT_KEY.test(key), 'deletion journal object key invalid');
    const response = await r2(credentials, { method: 'HEAD', objectKey: key }, signal);
    if (response.status === 404) return null;
    invariant(response.ok, 'deletion journal HEAD unavailable');
    const bytes = Number(response.headers.get('content-length'));
    const sha256 = response.headers.get('x-amz-meta-rv-sha256') ?? '';
    const eventId = response.headers.get('x-amz-meta-event-id') ?? '';
    const tenantLineageId = response.headers.get('x-amz-meta-tenant-lineage-id') ?? '';
    invariant(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 * 1024
      && SHA256.test(sha256) && UUID.test(eventId) && UUID.test(tenantLineageId),
    'deletion journal HEAD evidence invalid');
    return Object.freeze({ key, bytes, sha256, eventId, tenantLineageId });
  }

  async function listExact(credentials, key, signal) {
    invariant(OBJECT_KEY.test(key), 'deletion journal object key invalid');
    const query = [
      ['encoding-type', 'url'], ['list-type', '2'],
      ['max-keys', '2'], ['prefix', key],
    ];
    const response = await r2(credentials, { method: 'GET', query }, signal);
    invariant(response.ok, 'deletion journal list unavailable');
    const parsed = parseListXml(await boundedBytes(response, 64 * 1024));
    invariant(!parsed.truncated && parsed.keys.length === 1 && parsed.keys[0] === key,
      'exact deletion journal listing is ambiguous');
    const evidence = await head(credentials, key, signal);
    invariant(evidence, 'deletion journal object disappeared');
    return Object.freeze([Object.freeze({
      key, bytes: evidence.bytes, sha256: evidence.sha256,
    })]);
  }

  async function get(credentials, entry, signal) {
    const response = await r2(credentials, { method: 'GET', objectKey: entry.key }, signal);
    invariant(response.ok, 'deletion journal object unavailable');
    const bytes = await boundedBytes(response, 1024 * 1024);
    invariant(bytes.byteLength === entry.bytes && await sha256Hex(bytes) === entry.sha256,
      'deletion journal object evidence mismatch');
    return bytes;
  }

  return Object.freeze({
    async appendAndProve({ event, expectedSha256, signal }) {
      validateEvent(event);
      invariant(SHA256.test(expectedSha256 ?? ''), 'deletion journal expected digest invalid');
      const objectBytes = encoder.encode(`${canonicalJson(event)}\n`);
      const objectSha256 = await sha256Hex(objectBytes);
      invariant(objectSha256 === expectedSha256, 'deletion journal semantic digest mismatch');
      const objectKey = keyFor(event);
      const credentials = await privateAccessAndCredentials(signal);
      const put = await r2(credentials, {
        method: 'PUT',
        objectKey,
        body: objectBytes,
        headers: {
          'content-type': 'application/json',
          'if-none-match': '*',
          'x-amz-meta-event-id': event.eventId,
          'x-amz-meta-rv-sha256': objectSha256,
          'x-amz-meta-tenant-lineage-id': event.tenantLineageId,
        },
      }, signal);
      invariant(put.ok || put.status === 412, 'deletion journal append unavailable');
      const appended = await head(credentials, objectKey, signal);
      invariant(appended && appended.bytes === objectBytes.byteLength
        && appended.sha256 === objectSha256
        && appended.eventId === event.eventId
        && appended.tenantLineageId === event.tenantLineageId,
      'deletion journal append evidence mismatch');

      // The foreground delete proves only its immutable exact object. Global
      // journal enumeration belongs to the bounded background backup job, so
      // another tenant cannot inflate this ten-second request path.
      const first = await listExact(credentials, objectKey, signal);
      const firstPassRoot = await evidenceRoot(first);
      const second = await listExact(credentials, objectKey, signal);
      const secondPassRoot = await evidenceRoot(second);
      invariant(firstPassRoot === secondPassRoot
        && canonicalJson(first) === canonicalJson(second),
      'two-pass deletion journal proof changed');
      const bytes = await get(credentials, second[0], signal);
      let current;
      try { current = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
        throw new Error('deletion journal object invalid');
      }
      validateEvent(current);
      invariant(keyFor(current) === second[0].key
        && canonicalJson(current) + '\n' === new TextDecoder().decode(bytes),
      'deletion journal object canonical bytes invalid');
      const events = [Object.freeze({
        eventId: current.eventId,
        tenantLineageId: current.tenantLineageId,
        operation: current.operation,
        committedAt: current.committedAt,
      })];
      invariant(events.some(current => current.eventId === event.eventId
        && current.tenantLineageId === event.tenantLineageId
        && current.operation === event.operation
        && current.committedAt === event.committedAt),
      'deletion journal event missing from range proof');
      const rangeEnd = new Date(Math.max(now().getTime(), Date.parse(event.committedAt))).toISOString();
      return Object.freeze({
        objectEvidence: Object.freeze({
          format: 'rv-r2-append-evidence/2',
          objectKey,
          objectSha256,
          objectBytes: objectBytes.byteLength,
          ifNoneMatch: '*',
          headVerified: true,
          privateAccessVerified: true,
        }),
        rangeProof: Object.freeze({
          format: 'rv-deletion-journal-range-proof/2',
          rangeStart: '1970-01-01T00:00:00.000Z',
          rangeEnd,
          firstPassRoot,
          secondPassRoot,
          objectCount: second.length,
          snapshotJournalRoot: secondPassRoot,
          events: Object.freeze(events),
          storageClaim: 'private-r2-best-effort-append-only-not-worm',
        }),
      });
    },
  });
}

export { PREFIX as DELETION_JOURNAL_PREFIX };

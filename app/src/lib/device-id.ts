const KEY = 'rv-production-device-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getOrCreateDeviceId(random: Crypto = globalThis.crypto): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && UUID_PATTERN.test(stored)) return stored.toLowerCase();
  } catch {}
  if (!random || typeof random.randomUUID !== 'function') {
    throw new Error('SECURE_DEVICE_ID_UNAVAILABLE');
  }
  const created = random.randomUUID().toLowerCase();
  try { localStorage.setItem(KEY, created); } catch {}
  return created;
}

export function clearDeviceId(): void {
  try { localStorage.removeItem(KEY); } catch {}
}

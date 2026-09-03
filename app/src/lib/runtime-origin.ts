export function runtimeOriginMatches(expectedOrigin: string, actualOrigin: string): boolean {
  if (!expectedOrigin.trim()) return true;
  try {
    const expected = new URL(expectedOrigin.trim());
    const actual = new URL(actualOrigin.trim());
    if (
      expected.protocol !== 'https:'
      || expected.username
      || expected.password
      || expected.port
      || expected.pathname !== '/'
      || expected.search
      || expected.hash
    ) return false;
    return actual.origin === expected.origin && actual.href === `${actual.origin}/`;
  } catch {
    return false;
  }
}

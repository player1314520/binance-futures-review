# Support and version policy

## Candidate matrix

| Surface | Stage | Target environments | Support status |
|---|---|---|---|
| Web Core | public alpha | Current evergreen desktop/mobile browsers | Demo and local CSV/.fupan review workflow; no SLA |
| Shared engine | source-distributed with Web Core | supported Node.js versions in `package.json` | Versioned with the public repository; no standalone package support window |

Planned public releases use [Semantic Versioning 2.0.0](https://semver.org/). Alpha, beta, release-candidate, and `0.x`
versions are prerelease surfaces and do not promise a stable API. This alpha deployment has no paid support plan or SLA.

## Honest boundaries

1. Cross-platform CI does not prove behavior on every browser, device, locale, or accessibility setup.
2. A deployed synthetic demo and imported-file tests do not prove live-account, exchange-ledger, or complete-history behavior.
3. Semantic versioning communicates compatibility intent; it cannot guarantee freedom from defects or data gaps.
4. Security advisories, dependency changes, and platform changes require fresh review at release time.

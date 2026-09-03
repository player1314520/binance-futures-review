# Changelog

## 2026-08-30 · Production-closure candidate (unreleased)

### Added

- Atomic full-workspace restore for browser storage and the encrypted vault, including cross-tab exclusion, rollback recovery, clear-generation barriers, and stale-operation cancellation.
- A fail-closed Classic review migration flow with same-origin detection, file import, current-dataset binding, explicit per-trade selection, and no-overwrite semantics.
- Evidence-bearing single-variable action experiments with a hypothesis, bounded sample window, observations, success criterion, and adopt/revise/discard decisions.
- Inclusive custom report ranges of up to 366 days alongside the existing week and month shortcuts.

### Changed

- Browser review, action, experiment, journal, guard, migration, restore, and clear operations now share one transaction domain and merge against the latest persisted workspace state.
- Browser clear uses compact forward-recovery journals and an opaque epoch repair fence; stale tabs cannot reuse a new generation, while browsers without Web Locks fail closed.
- Portable restore accepts only a declared full-workspace envelope: deterministic Demo archives remain offline synthetic data, while Binance archives restore as offline imports without credentials or live-account identity.
- Classic export logic now lives in a product-neutral shared module used by both the compatibility wrapper and the web application.

### Honest limits

- This entry describes the current release branch, not proof that its clean commit has been published or that the production backend is live.
- Cross-origin Classic storage requires an export from the old origin; unmatched trade IDs are not guessed from time, price, or PnL.
- User-entered experiment observations can measure execution consistency but cannot prove profit improvement or causality.
- Tabs that were already running an older build do not understand the new transaction protocol and must be refreshed before cross-tab guarantees apply.

## 2026-08-28 · Web Core public alpha

### Added

- A responsive Binance USDⓈ-M futures review desk for deterministic demo, CSV/`.fupan` import, analytics, and per-trade review.
- A pinned GitHub Pages deployment workflow with an exact build-commit marker and `release.json` provenance.
- Runtime dependency license inventory, browser-only privacy controls, and a one-click review-data reset.

### Changed

- Imported trade data is memory-only; reloading the page returns to the synthetic demo while review notes remain separately erasable.
- The public page no longer presents Binance credentials. Read-only account sync remains an optional loopback companion capability.

### Honest limits

- The public site does not place or cancel orders, generate trading signals, or provide investment advice.
- Imported results describe only the selected file and do not prove complete account or exchange-ledger reconciliation.
- Direct Binance account sync requires the separately operated local companion and is not available from the public origin.

## 2026-08-11·p0-quality-v2-rc1

### Added

- A no-history, exact-allowlist staging path for the Open 2.0/core candidate.
- Deterministic SHA-256 inventory generation and fail-closed staged-tree checks.
- Candidate-only package and workspace metadata for frozen install, focused tests, and the Vite build.
- Public governance documents that keep the staged Markdown link graph closed.

### Verification contract

- Export twice and require byte-identical manifests.
- In a disposable Windows staging tree, run `pnpm install --frozen-lockfile --offline`, `pnpm test`, and `pnpm build`.
- Keep the private source package marked `private: true` and keep `DISTRIBUTION.md` at `STATUS: not_distributed`.

### Honest limits

- This entry identifies a local release candidate; it is not evidence of publication, deployment, or public distribution.
- The candidate contains only the allowlisted Open 2.0/core surface and excludes private 1.0, account runtime, local data, and Git history.
- Equivalent clean-staging evidence has not been collected on Linux or macOS, and no remote candidate workflow has run.
- A candidate-specific third-party license review and SPDX artifact remain release gates.

# WP13 public staging foundation

`scripts/export-public-staging.mjs` makes a local, no-history candidate tree from the exact files in
`scripts/public-staging-allowlist.json`. The target must already exist, be absolute, and be empty. The exporter rejects
path traversal, private/runtime paths, links or reparse points, non-regular files, unexpected staged files, governance
drift, and privacy findings. It writes a deterministic `PUBLIC-STAGING-MANIFEST.json` and binds the exact
`DISTRIBUTION.md` state. Pre-release candidates use `STATUS: not_distributed`; an authorized release snapshot may use
`STATUS: distributed` only when it includes one HTTPS `PUBLIC_URL`.

The manifest binds each staged file plus the source commit, source Git tree, observed clean state, SHA-256 of the exact
source inputs, SHA-256 of the embedded allowlist, a candidate-tree SHA-256, and the exporter/Node/pnpm/Git tool versions.
The candidate-tree digest excludes the manifest itself to avoid a circular hash. A release export fails closed unless the
source is a clean Git worktree at a full commit and every source input is a tracked blob whose bytes match that commit.
Both CLI and programmatic callers must name `release` or `non-release-test` explicitly. The latter exists only for
deterministic fixture tests and records `releaseEligible:false`; it is not release evidence.

The v2 policy maps dedicated, tracked public metadata onto the candidate's root `package.json`, `pnpm-workspace.yaml`,
and `frontend/package.json`. The private repository metadata is inspected for `private:true` and AGPL governance but is
not copied over those public candidate files. The public root remains `private:true` to fail closed against accidental
npm publication.

Local source export:

```text
node scripts/export-public-staging.mjs --target <absolute-empty-directory> --mode release
cd <absolute-empty-directory>
pnpm install --frozen-lockfile --offline
pnpm test
pnpm typecheck
pnpm build
pnpm verify:compliance
```

The tree has deliberately not been initialized as a repository by the exporter. After separate authorization creates a
new public Git repository, its first commit must use the exact subject `Review Workbench public candidate root` and contain
only the release manifest's exact candidate snapshot. `pnpm verify` additionally scans every Git blob and commit, author/committer metadata,
annotated tag metadata, tree-entry names, the clean HEAD/index/worktree, current-tree privacy, SPDX/NOTICE/license drift,
tests, typecheck, and build. Object enumeration includes reachable and dangling/unreachable local objects. The history
gate requires the prescribed public noreply identity; rejects replacement refs, alternate/promisor object stores,
inherited roots, and unreachable commit objects; and rejects the private source commit if it is present as a candidate Git
object. Later public commits and PR heads are allowed only when they descend from that one immutable root snapshot. All Git
reads disable fsmonitor, lazy fetch, replacement objects, and inherited Git configuration/environment overrides. It never
imports or mirrors the private repository history.

The candidate includes `.gitattributes` to keep reviewed text at LF across Windows/Linux/macOS checkouts and `.gitignore`
to exclude only known install/build outputs such as `node_modules/` and `dist/`. The release gate still requires every
non-ignored path, index entry, and HEAD blob to match the manifest; staging different bytes and restoring only the working
copy fails closed.

The staged compliance packet contains candidate-specific `sbom.spdx.json`, `THIRD_PARTY_NOTICES.md`, and `LICENSES/`.
Its dependency inventory is deterministic from the exact public manifests, lockfile, and AGPL license. The nine-package
browser runtime closure is separately bound to npm tarball integrity values and included MIT notices. Build/test-only
packages remain `NOASSERTION` because those package bytes are fetched by contributors or CI and are not copied into the
deployed browser artifact. Sensitive vulnerability evidence may be sent only through a private channel already confirmed
with the maintainer, never through a public issue.

The SPDX graph includes workspace containment, direct importer dependencies, and transitive snapshot dependencies.
Workspace licenses are taken only from their own manifests: a contradictory child license fails generation, while a child
manifest with no license is recorded as `NOASSERTION` rather than being silently relabeled AGPL.

Windows clean-staging evidence on 2026-08-11 used a newly created temporary target and passed the frozen offline install,
the focused Node and Vitest suites, and the Open 2.0 Vite production build. The temporary candidate, dependencies, and
build output were enumerated and removed after verification.

The 2026-08-20 B8 slice repeated the no-history export and candidate-local gate tests, but its fresh offline install could
not complete because the local pnpm store lacked the pinned `react-router-dom@7.18.2` tarball. Network access was not
authorized, so this run did not fetch the package and is not new clean-candidate build evidence. The older 2026-08-11
result remains historical evidence only; the exact future release candidate still needs a fresh install and build.

Honest boundaries:

1. The exporter does not scan, rewrite, copy, or certify the private Git history; the full-history gate applies only to the
   newly initialized candidate repository and anchors its unique root to the exact initial release snapshot. This local
   self-contained anchor does not replace an independently retained manifest/hash approval record.
2. Linux and macOS clean staging were not run or verified in this local slice; Windows evidence cannot be generalized to
   those platforms. All three systems must verify the same candidate commit remotely after separate push authorization.
3. The offline install reused a locally populated pnpm store; it does not prove installation from an empty cache or future
   registry availability.
4. It does not publish, push, deploy, change repository visibility, or create a public repository by itself; those actions
   still require the owner's explicit approval. A non-release export remains `STATUS: not_distributed`.
5. SHA-256 and SPDX prove byte identity and inventory structure, not source correctness, legal advice, license
   compatibility, or future vulnerability status. Any dependency added to the browser runtime must be independently
   resolved and added to the runtime license packet before release.
6. Link/reparse rejection relies on the file types reported by the host filesystem and Node.js; a later release audit must
   repeat the checks on the actual release host and exact candidate tree.
7. The history scanner examines local Git objects and metadata but cannot prove that a remote host, registry, or later
   rewritten repository contains the same objects until the exact pushed commit is independently verified.

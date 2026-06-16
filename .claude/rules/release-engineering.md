---
globs: "package.json, packages/**/package.json, .github/workflows/*.yml, scripts/**, tsconfig*.json"
---

# Release Engineering & Package Publishing

Applies to the framework monorepo and any multi-package library this organization publishes. The principles generalize; the mechanics reference the `@quanticjs/*` release line.

## Internal Dependencies — peerDependencies, Not Regular Dependencies

Every internal cross-package edge (e.g. `@quanticjs/core` from `@quanticjs/redis`) uses:

```json
"peerDependencies": { "@quanticjs/core": "~7.0.0" },
"devDependencies":  { "@quanticjs/core": "*" }
```

- Why: a caret-ranged regular dependency lets npm nest a **second copy** of core — DI tokens are per-copy `Symbol`s, so pipeline behaviors silently no-op; a **tilde** peer turns skew into an install-time `ERESOLVE` error (exact pins would force consumer upgrades on every core patch). `devDependencies: "*"` keeps workspace symlinks resolving in local dev; npm ignores devDeps when published.
- **Umbrella exception:** the `quanticjs` umbrella keeps core as a regular dependency pinned **exact**; its optional peers use the tilde range.
- Verify after restructure: `npm ls @quanticjs/core` in a consumer fixture shows exactly one deduped instance; a deliberately skewed pair fails with `ERESOLVE`.

## Versioning — Fixed (Lockstep) + Version-Sync Script

All packages are one framework released as a unit — fixed lockstep versioning, not changesets/independent versions (independent versioning is what produced drift and the dual-copy hazard).

- `scripts/sync-versions.mjs <version>` is the single source of truth: sets every package version, rewrites internal peer ranges to `~<version>` and the umbrella pin to exact, refreshes the lockfile (`npm install --package-lock-only`).
- **The tag must point at a commit with synced versions.** CI runs the sync script in `--check` mode and fails *before publishing anything* on mismatch — version stamping is a **verification**, never a rewrite. The repo state always matches what was published.
- Hotfixes on an old line: branch `release/<major>.x`, sync, tag there.

## Publish Workflow Invariants

1. **`npm ci --ignore-scripts` from the pristine committed lockfile, BEFORE any manifest mutation.** Never `npm install` in the publish path; never rewrite `package.json` before installing. `--ignore-scripts` blocks dependency lifecycle-script supply-chain execution; native deps are rebuilt explicitly and alone (allowlist): `npm rebuild @confluentinc/kafka-javascript`. Do NOT add `--ignore-scripts` to `npm publish` itself — our own future `prepublishOnly` hooks must keep working; the install is the attack surface.
2. **Quality gate before publishing:** `turbo run build`, `lint`, `test:cov`, `test:integration`, `node --test scripts/*.test.mjs` (release-tooling self-test), and the `AllowAnonymous` regression grep.
3. **Idempotent per-package publish:** `npm view <name>@<version>` pre-check — already-published packages are skipped with a log line, so re-running a half-failed release publishes only the remainder and exits green. Treat `EPUBLISHCONFLICT` as a skip (registry read-after-write lag), not a failure.
4. **No provenance (private source repo):** publishes run with `--access public` only. npm rejects `--provenance` from private source repos (E422 "Only public source repositories are supported" — hit on the first v7.0.0 attempt). If the repo goes public, restore `--provenance` on `npm publish` and `id-token: write` in workflow `permissions`. Every package keeps `repository` + `directory` so npmjs links to the monorepo subdirectory (and provenance works the moment it is re-enabled).
5. **Halt on first failure** (`set -euo pipefail`) with a message naming the failed package and stating that re-running resumes safely.
6. **Publish-list drift guard:** the list of packages to publish is checked against `ls packages/` — a new package directory missing from the list fails the workflow.

## Changelogs, Migration Guides, ADRs

- Root `CHANGELOG.md` via `conventional-changelog` (input quality guaranteed by conventional-commit PR titles + squash merges — see `testing-patterns.md` → CI Pipeline). One changelog for the whole framework; lockstep versions make per-package changelogs redundant.
- **`docs/migrations/v<major>.md` is a release blocker** for any breaking release: it aggregates every spec's `Breaking Changes & Migration` section. No breaking release ships without it. (Enforced by the `/publish` procedure, not CI — the maintainer checklist is the gate.)
- Decisions referenced from code or rules must have a real ADR (`docs/adr/ADR-NNN-*.md`, Status/Context/Decision/Consequences). Backfill with status "Accepted (backfilled)" when discovered missing.

## Source Maps in Published Packages

`tsconfig.base.json`: `"sourceMap": true, "declarationMap": true, "inlineSources": true`.

- `inlineSources` embeds the TS source inside `.js.map`, so consumer stack traces resolve to real source **without shipping `src/`** in the tarball (`"files": ["dist"]` picks up the maps automatically).
- Consumers only benefit at runtime with `node --enable-source-maps` (see `docker-patterns.md`).
- Tarballs grow ~30–60% — accepted for on-call debuggability; measure with `npm pack --dry-run` when changing.

## Release Procedure (maintainers)

1. `npx turbo run build test` green.
2. `node scripts/sync-versions.mjs <new-version>` → review diff.
3. `npm run release:changelog` (angular preset with `--pkg packages/core/package.json` — the root manifest is a private 0.0.0 placeholder, so the version comes from core) → review/curate.
4. Breaking release: verify `docs/migrations/v<major>.md` covers every breaking change — blocker.
5. Commit `chore(release): v<new-version>` (versions + lockfile + changelog), tag, push.
6. CI verifies + publishes; re-run on transient failure (idempotent skip).

## NEVER

- **NEVER** declare an internal `@quanticjs/*` package as a caret-ranged regular dependency — peerDependency with tilde range + `devDependencies: "*"` (umbrella exception only)
- **NEVER** run `npm install` (instead of `npm ci`) in a publish workflow, and NEVER mutate `package.json` before the install — the committed lockfile is authoritative end-to-end
- **NEVER** run a publish install without `--ignore-scripts` — rebuild native deps explicitly from an allowlist
- **NEVER** let CI rewrite versions at publish time — versions are committed by the sync script; CI only verifies
- **NEVER** add `--provenance` (or `id-token: write`) while the source repo is private — npm rejects it with E422 and the release fails mid-loop. If the repo goes public, restore both in the same PR
- **NEVER** write a publish loop that cannot be safely re-run — pre-check `npm view`, skip already-published versions
- **NEVER** tag a breaking release without `docs/migrations/v<major>.md`
- **NEVER** ship `src/` in tarballs — `inlineSources` source maps provide debuggability without it

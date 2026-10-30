---
name: release
description: Cut a release of the @xandreed/* framework packages, only on explicit maintainer sign-off — the shared version bump, CHANGELOG, journal fixture, docs:generate, build and verify, the publish dry run then --publish, and the v<version> tag that deploys the docs site. Read before any version bump, npm publish or release tag.
---

# Cut a release

Publishing to npm and pushing a `v<version>` tag are outward-facing and
cannot be taken back. Do none of it without the maintainer's explicit
sign-off for that release, and stop at each step marked **sign-off** for a
fresh yes. CONTRIBUTING.md, "Publishing", is the full reference, including
everything `publish:packages` refuses.

## 1. The release PR

All publishable packages (`names` in `scripts/build-packages.ts`) share one
version and publish together under npm's `latest` tag.

1. Set the new version in every publishable `packages/<name>/package.json`
   and in every plugin definition (`version:` in each `definePlugin`).
2. `bun run docs:generate` (the plugin reference carries the versions).
3. In `CHANGELOG.md`, turn **Unreleased** into `## <version> — <date>`, with
   its headings intact, and start a new empty **Unreleased**.
4. Set the version in the "published at" sentences: `README.md`,
   `packages/website/src/content/docs/getting-started.md` and
   `packages/website/src/pages/index.astro`. Drop any README exception for a
   package not yet on npm.
5. A package published from an earlier line must have no npm version at or
   above the new one: `npm view @xandreed/plugin-telemetry versions`.
6. Record the release's journal fixture: `bun scripts/record-journal-fixture.ts`
   writes `packages/sdk/fixtures/journal-<version>.json` (it refuses to
   overwrite one; `--force` only while that version is unreleased), with the
   release's `storedFormat`, which `docs/stored-format.json`'s history must
   hold (`journal-compat.test.ts` checks it). Record its
   evaluation run the same way: `bun scripts/record-run-fixture.ts` writes
   `packages/evals/fixtures/run-<version>.json`.
7. Run every gate (below), open the PR titled `release <version>` (skill
   `commit-style`) and merge it. Merging publishes nothing.

## 2. Publish (**sign-off**)

From a clean checkout of the merge commit (no changes, no untracked files):

```sh
bun install --frozen-lockfile
bun run build:packages            # also writes .artifacts/packages/build.json
bun run verify:packages
bun run publish:packages          # dry run: every check, then npm publish --dry-run
bun run publish:packages --publish
```

- Run the last line from an interactive terminal: npm asks for the second
  factor there, and `npm whoami` must name the project's account.
- A run that stopped part-way can be repeated from the same commit: versions
  already on the registry are skipped. Never publish from a commit whose
  version is partly on npm unless it is the commit those came from.

## 3. Tag (**sign-off**)

- Only after the packages are on npm: tag the merge commit `v<version>` and
  push the tag. Pushing a `v*` tag deploys the documentation site from that
  tag (`.github/workflows/docs.yml`), so it needs the same sign-off as the
  publish.
- Never move or delete a pushed release tag.

## Gates before the release PR

```bash
bun run typecheck && env -u HTTP_PROXY -u HTTPS_PROXY bun test && bun run foundry demo
bun run build:packages && mkdir -p .artifacts/tmp && TMPDIR=$PWD/.artifacts/tmp bun run verify:packages
bun run docs:generate && bun run --cwd packages/website check
```

## Checklist

- [ ] Explicit sign-off for this release
- [ ] One version in every package.json and every `definePlugin`
- [ ] docs:generate; CHANGELOG section dated; README and website versions
- [ ] Earlier-line npm versions checked
- [ ] Journal fixture recorded for the new version
- [ ] Gates green; `release <version>` PR merged
- [ ] Dry run clean, then `--publish` from a clean checkout of the merge commit (sign-off)
- [ ] `v<version>` tag pushed after npm has the packages (sign-off)

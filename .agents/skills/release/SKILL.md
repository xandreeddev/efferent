---
name: release
description: Prepare Changesets release PRs and publish the exact tested release through GitHub Actions, including npm provenance, immutable tags, GitHub releases and docs deployment. Read before versioning, publishing or tagging.
---

# Release through GitHub Actions

Releases use `.github/workflows/release-pr.yml` and `release.yml`.
All publishable packages (`names` in `scripts/build-packages.ts`) share one
version. Changesets has one fixed group for them, including private source
packages; the framework publisher uploads the isolated distribution build.
CONTRIBUTING.md, "Publishing", is the complete workflow and setup reference.

## Authorization

Publication, tags and docs deployment are outward-facing. Maintainer approval
and merging a generated `release <version>` PR signs off on that release's CI
publication after main CI succeeds. An explicit `release.yml` workflow dispatch
signs off on the selected release or retry. An existing user instruction to
perform that release is authorization to complete these steps; do not request
it again. Do not publish a different version or an unreviewed source commit.

## 1. Record release intent

- Package changes add a changeset with `bun run changeset` and the normal
  **Unreleased** changelog entry. Patch, minor or major intent in any fixed
  package versions the whole framework group consistently.
- Repository-only changes need not bump packages.
- Keep `.changeset/config.json` and `releaseDirectories` in
  `scripts/release-version-plan.ts` synchronized with the build list when
  adding packages; versioning tests enforce this.

## 2. Review the generated release PR

When changesets reach main, `release-pr.yml` calls `release:version` and
updates the bot-owned `changeset-release/main` branch. It consumes notes,
bumps manifests, synchronizes `definePlugin` versions and version markers,
dates the central changelog, records the new journal and evaluation fixtures,
updates lock metadata and regenerates documentation. Never overwrite an
existing released fixture to silence a test.

The workflow explicitly dispatches `ci.yml` on that branch to supply its
required CI check with `GITHUB_TOKEN`. Review all generated files, fix any
failures and merge using the repository's `commit-style` rules. The PR title
is exactly `release <version>` so the publish selector can recognize it.

## 3. Publish in CI

After the merged release commit passes main's `ci`, `release.yml` verifies
its exact Actions workflow/check, main ancestry, version, changelog and
compatibility fixtures. It builds and verifies the source, publishes in
dependency order, confirms every registry version, pushes `v<version>`,
creates the GitHub release and dispatches docs deployment at that tag.

For an already prepared release or an interrupted run:

```sh
gh workflow run release.yml --ref main -f version=<version>
```

The selector resolves the original release commit, not a later same-version
feature commit. Supply `-f commit=<full-sha>` if more than one release commit
has the same title. A retry must preserve the original publication source.

The checked pipeline can publish a clean historical checkout using
`release-publish.ts --ci --root <source> --verify`. These flags are for the
validated GitHub Actions context; local use retains interactive authentication.

## 4. Authentication and recovery

- Bootstrap new package names with a short-lived npm granular token stored
  directly as the repository secret `NPM_TOKEN`: `@xandreed` scope read/write
  publish-and-stage and bypass 2FA. Never ask for a token in chat or put one
  in a tracked file. Missing authentication is an external setup requirement,
  not a reason to weaken release guards or publish from a local terminal.
- Configure trusted publishing for each package with repository
  `xandreeddev/efferent`, workflow `release.yml`, and direct-publish permission;
  then remove the bootstrap token. The CI job has `id-token: write`, Node 24
  and npm 11.15.0. OIDC cannot be checked with `npm whoami`.
- Source and build must share one version and commit, with no source changes.
  Registry `gitHead` must match for a partial-release resume. Check local and
  remote tags before uploading and again before pushing; never move a release
  tag. Confirm ambiguous npm upload failures through the registry.
- Tags pushed with `GITHUB_TOKEN` do not trigger another push workflow. The
  release job explicitly dispatches `docs.yml` only after npm confirmation.
- `bun run release:publish` is an interactive recovery tool, used only when
  the maintainer explicitly requests local publication. Routine releases run
  in GitHub Actions.

## Checks

Run the definition of done from root AGENTS.md. Release script and workflow
policy tests run within `bun test`; the package verification exercises the
packed artifacts on Node and Bun. New release fixtures stay compatible with
all recorded prior releases. Provider-backed quality claims require their
own configured models, credentials and evidence.

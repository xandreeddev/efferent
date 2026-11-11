# Contributing to efferent

This repository holds the framework only: the coding CLI and the reference
applications moved to their own repositories on 2026-10-28. The rules for
the code are in the root [`AGENTS.md`](AGENTS.md); this file is the process
around them.

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.3 (CI pins 1.3.0) and Node ≥ 24.5 on
Linux: `verify:packages` runs the packed packages on Node, and
`@xandreed/plugin-models` declares 24.5. Development runs TypeScript
directly; distribution builds emit JavaScript and declarations.

```bash
git clone https://github.com/xandreeddev/efferent && cd efferent
bun install
```

`bun install` also installs a git pre-commit hook (`scripts/installHooks.ts`,
in a standard checkout) that runs the repo gate profile before each commit.
Keep it; never commit with `--no-verify`.

A second working copy is a git worktree under `.worktrees/`, which git
ignores, not a folder beside the checkout:

```bash
git worktree add .worktrees/<name> -b <name> --no-track origin/main
cd .worktrees/<name> && bun install --frozen-lockfile
```

Install inside it before anything else: a worktree without its own
`node_modules` resolves packages from the checkout that holds it.
`--no-track` keeps the new branch from taking `main` as its upstream, which
a `push.default` of `tracking` or `upstream` would push to.

The tests expect no proxy in the environment: Bun's fetch sends even the
loopback servers they start to `HTTP_PROXY` / `HTTPS_PROXY`, so run them with
those unset (the proxy tests that would go direct skip when one is set).

## Gates and semantic review

Gates check declared syntax and dependency contracts. Review must also assess ownership, races, bounded work, algorithmic cost, meaningful assertions and current documentation. Confined local builders are allowed when mutation does not escape. Passing a gate does not establish these semantic properties.

The definition of done is the root `AGENTS.md` "Definition of done": the
commands `.github/workflows/ci.yml` runs, in order. Its "Gate rules" table
lists every rule `bun run typecheck` applies (the repo profile over every
package, foundry's source included, then tsc over `scripts/`), and
`bun run foundry check` runs foundry's own layer profile. A test
(`scripts/agents-guide.test.ts`) keeps that table and that list in step
with `foundry.config.ts` and `ci.yml`.

The committed baseline (`.foundry/baseline.json`) stays empty, and
`bun run typecheck` fails while it holds a fingerprint
(`quality/baseline-empty`): the repo profile grandfathers nothing. Fix a
finding instead of passing `--update-baseline --allow-grow`; that flag
warns that CI will refuse the grown file.

## Adding a package or a plugin

Follow the `add-plugin` skill (`.agents/skills/add-plugin/SKILL.md`). A new
package under `packages/` must be registered by hand, and
`bun run typecheck` fails (`quality/package-registered`) naming each list
it is missing from:

- `CHECKED` in `foundry.config.ts` (`"packages/<name>/src/**"`), so the
  rules check its sources;
- a `boundaries.layers` entry in `foundry.config.ts`, so its imports are
  checked, and a `<name>-tests` layer before it (`testLayer`) for its test
  code, the only layer that may import a test library;
- `names` in `scripts/build-packages.ts`, so it is built, verified and
  published (foundry, development tooling, is exempt);
- `compilerOptions.paths` in `tsconfig.base.json` (`"@xandreed/<name>"`);
- for a `plugin-*` package, `firstParty` in
  `scripts/generate-plugin-reference.ts` (import the package and list its
  plugins; `bun run docs:generate` also fails on an exported plugin missing
  there).

The lists the check reads are the `registration` data in
`foundry.config.ts`; the docs site (`packages/website`) is exempt.

## PRs

The repository limits PR creation to collaborators (`collaborators_only`)
and requires Actions approval for all external contributors
(`all_external_contributors`). CI runs only in `xandreeddev/efferent` and
skips fork PRs. Same-repository PR events are eligible for the required check;
release previews use the maintainer-owned PR handoff below.

- Branch off `main`; PRs squash-merge, so the PR title becomes the commit
  title and the body its message: write both as the `commit-style` skill
  says.
- Keep a PR to one concern; tests ride the same PR as the change.
- New agent behavior ships with its evaluation — a calibration or a journey
  (`docs/composable-evaluations.md`); the battery is part of the definition of done.
- Colocate tests next to the source (`foo.ts` / `foo.test.ts`); fixtures live
  outside `src/` so the gates never see deliberate violations.
- A change to a documented contract updates `docs/framework.md` and the
  matching page under `packages/website/src/content/docs/concepts/` in the
  same PR. Their `@xandreed/*` imports in code blocks are compiled against
  the packed packages (`verify:packages`); generated pages are never edited
  by hand.
- Run `bun run docs:generate` after a change to an event, a stored payload,
  or a plugin's id, version, scope, configuration schema, defaults,
  `requires`, `optional`, `provides` or `contributes`. It writes the
  [plugin](docs/plugin-reference.json) and [event](docs/event-reference.md)
  references, the guides' snippets and their website pages; CI fails on any
  difference from what is committed.
- Each exported first-party plugin has a guide in
  `packages/website/src/content/docs/plugins/`, named from its id: remove
  `@xandreed/plugin-` and replace `/` with `-`. Set its `pluginId`, title and
  description in frontmatter. Write setup, composition and examples outside
  the `plugin-reference:start/end` markers; `docs:generate` refreshes the
  contract inside them and the sidebar navigation. Missing or orphaned guides
  fail generation. `scripts/plugin-docs.test.ts` checks coverage, freshness and
  TypeScript examples against the current public APIs.
- What each published entry exports is recorded in `api/`: one file per
  entry, `api/<package>.api.txt` for a package's root and
  `api/<package>--<subpath>.api.txt` for each other entry (every `/` of the
  subpath a `--`), each the sorted `kind name` lines of its exports, read
  from the build's declarations (`scripts/api-snapshot.ts`). After a change
  that adds, removes or renames an export, or turns a value export into a
  type-only one, run `bun run api:update` (it runs `build:packages`, then
  rewrites `api/`) and commit the diff; `verify:packages` fails while `api/`
  differs from the build. A package's root entry may not export a name
  declared in a package's `src/internal/` folder: those modules are
  published through an entry of their own, outside semver.
- A change to a stored shape bumps `STORED_FORMAT` (skill `change-event`),
  and every bump needs a fresh store: Sessions refuses a session of any
  other format for every operation, reads included, with `session.version`,
  and nothing migrates it. The built-in backends record the format a store
  was created for and refuse a store of another format when it opens
  (`store.version`), so no layout bump is needed. Say so under **Migration**.
- Every release's journal fixture is kept, byte-identical to its tag, as
  historical evidence of what that release wrote
  (`packages/sdk/fixtures/journal-<version>.json`).
  `packages/sdk/src/journal-compat.test.ts` replays the fixtures at the
  current `STORED_FORMAT` with this release's schemas, and checks that
  Sessions refuses every other with `session.version` and leaves its bytes
  unchanged: there is no migration or compatibility decoding. Record one per
  release with
  `bun scripts/record-journal-fixture.ts`. It refuses to overwrite an
  existing release fixture. During development, record
  `journal-unreleased.json` with `bun scripts/record-journal-fixture.ts --unreleased`;
  `--unreleased --force` refreshes only that development fixture. Evaluation reports follow
  the same rule: `packages/evals/src/run-compat.test.ts` reads each
  `packages/evals/fixtures/run-<version>.json`, recorded with
  `bun scripts/record-run-fixture.ts`.
- The sdk golden (`packages/sdk/src/agent.golden.test.ts`) pins one
  conversation byte for byte: what the model and the host see
  (`packages/sdk/golden/agent-turn.model.json`) and what the session stores
  (`agent-turn.journal.json`). After a deliberate change, re-record with
  `EFFERENT_UPDATE_MODEL_GOLDEN=1` (model text) or `EFFERENT_UPDATE_GOLDEN=1`
  (storage format) on `bun test packages/sdk/src/agent.golden.test.ts`, read
  the whole `git diff` of the golden, and explain each change in the PR.
  Never re-record to silence a failure you cannot explain.
- A guide's code is not edited in the guide: `docs/events.md` quotes the
  regions of `packages/sdk/src/events-guide.test.ts`, a test that runs, and
  `bun run docs:generate` (`scripts/sync-guides.ts`) copies them in with the
  imports they use and writes the guide's website page. It fails on a
  snippet that imports from a relative path, the test runner (`bun:`) or
  test scaffolding (a `testing` module), a region no guide quotes, a
  snippet marker not followed by a `ts` fence, a TypeScript or JavaScript
  fence that is neither a snippet nor marked `<!-- unchecked: why -->`, and
  a link to a missing file or heading.
- Add an entry under **Unreleased** in `CHANGELOG.md`: what changes for
  someone using the packages. Use its headings: `### Migration` (what a
  user must do), `### Breaking`, `### Added`, `### Fixed` and
  `### Repository` (changes to this repository only). Start a package's
  entry with its name (`` `@xandreed/plugin-render`: ``).

## Publishing

Releases run in GitHub Actions. All 24 publishable packages share version
`0.21.1` in source and publish together under npm's `latest` tag. Changesets
versions this fixed group; the release workflow publishes the isolated build
from `.artifacts/packages`, whose manifests have `private: false`.

### Release PRs

1. Add a changeset with `bun run changeset` in a package-change PR. Choose
   the affected package and patch, minor or major intent. The fixed group
   makes every framework package take the same resulting version. Keep the
   usual entry under **Unreleased** in `CHANGELOG.md` too.
2. After changesets reach `main`, `release-pr.yml` runs `release:version`
   and opens or updates `changeset-release/main`. It consumes the notes,
   synchronizes package and plugin versions, updates the central changelog
   and version markers, records the new journal/run fixtures and regenerates
   docs. Existing source-package visibility is preserved, including private
   packages such as core. Changesets versions the whole group, while the
   framework publisher handles distribution artifacts.
3. Review the generated bot preview, then follow the maintainer-owned PR handoff
   below. Merge the new maintainer-owned PR, titled `release <version>`, after
   its required `pull_request` CI passes.
4. After the merged release commit passes main's `ci`, `release.yml`
   verifies its source SHA, version, dated changelog, compatibility fixtures
   and the trusted Actions check. It builds and verifies the packed packages,
   runs the publishing dry run, publishes in dependency order, confirms every
   version on npm, pushes `v<version>`, creates the GitHub release and
   dispatches the docs deployment at that tag. Its separate `landing` job
   then publishes the release README as the unscoped `efferent` package.

Merging the release PR signs off on package publication, the immutable tag
and documentation deployment. Ordinary feature commits retaining the current
version do not publish. A Changesets note is unnecessary for repository-only
changes that should not bump the framework version.

### Maintainer-owned release PR

The workflow's bot PR is a preview. GitHub can retain that PR author's name
when squash merging even with `--author-email`; closing and reopening it does
not change the author. Create a **new** PR under the maintainer's account from
the same reviewed branch, head and base. No personal access token is added to CI.
The new PR triggers `pull_request` CI. GitHub's [required-check documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)
explains why dispatched workflow jobs cannot satisfy PR ruleset checks.

After reviewing the preview diff, substitute its PR number, release version,
full head SHA and full base SHA below. If either SHA changes, review again.
The identity guards reject a different account, fork, branch, base or PR title.

```sh
(
set -eu
RELEASE_REPO=xandreeddev/efferent
PREVIEW_PR='<preview-pr-number>'
RELEASE_VERSION='<version>'
REVIEWED_HEAD='<reviewed-full-head-sha>'
REVIEWED_BASE='<reviewed-full-base-sha>'
test "$(gh api user --jq '[.login, .name] | join("|")')" = 'xandreeddev|Xand Reed'
pr_identity() {
  gh api "repos/$RELEASE_REPO/pulls/$1" --jq \
    '[.state, .draft, .user.login, .head.repo.full_name, .head.ref, .head.sha, .base.repo.full_name, .base.ref, .base.sha, .title] | join("|")'
}
test "$(pr_identity "$PREVIEW_PR")" = \
  "open|false|github-actions[bot]|$RELEASE_REPO|changeset-release/main|$REVIEWED_HEAD|$RELEASE_REPO|main|$REVIEWED_BASE|release $RELEASE_VERSION"
HANDOFF_BODY="$(mktemp)"
cat > "$HANDOFF_BODY" <<'EOF'
## What

- Release the reviewed package versions, notes, fixtures and generated docs.

## Checks

- The required PR `ci` check must pass on this reviewed source before merging.
EOF
gh pr close "$PREVIEW_PR" --repo "$RELEASE_REPO" # Keep the branch: no --delete-branch.
OWNER_PR_URL="$(gh pr create --repo "$RELEASE_REPO" --base main \
  --head changeset-release/main --title "release $RELEASE_VERSION" --body-file "$HANDOFF_BODY")"
OWNER_PR="${OWNER_PR_URL##*/}"
rm "$HANDOFF_BODY"
EXPECTED_OWNER="open|false|xandreeddev|$RELEASE_REPO|changeset-release/main|$REVIEWED_HEAD|$RELEASE_REPO|main|$REVIEWED_BASE|release $RELEASE_VERSION"
test "$(pr_identity "$OWNER_PR")" = "$EXPECTED_OWNER"
CI_RUN=''
for ATTEMPT in 1 2 3 4 5 6 7 8 9 10 11 12; do
  CI_RUN="$(gh api "repos/$RELEASE_REPO/actions/runs?event=pull_request&head_sha=$REVIEWED_HEAD&per_page=100" --jq \
    "[.workflow_runs[] | select(.event == \"pull_request\" and .head_sha == \"$REVIEWED_HEAD\" and .path == \".github/workflows/ci.yml\" and any(.pull_requests[]?; .number == $OWNER_PR))][0].id // empty")"
  test -z "$CI_RUN" || break
  test "$ATTEMPT" -eq 12 || sleep 5
done
test -n "$CI_RUN" || {
  printf 'CI has not registered; keep %s open and resume waiting for this reviewed source.\n' "$OWNER_PR_URL" >&2
  exit 1
}
gh run watch "$CI_RUN" --repo "$RELEASE_REPO" --exit-status
gh pr checks "$OWNER_PR" --repo "$RELEASE_REPO" --required --watch
test "$(pr_identity "$OWNER_PR")" = "$EXPECTED_OWNER"
gh pr merge "$OWNER_PR" --repo "$RELEASE_REPO" --squash \
  --match-head-commit "$REVIEWED_HEAD" --author-email xandreed@proton.me \
  --subject "release $RELEASE_VERSION" \
  --body 'Synchronize the shared package and plugin versions, release notes, compatibility fixtures and generated documentation.'
)
```

If the run appears late or awaits approval, retain the new owner PR and resume
CI discovery/waiting with that PR number and the same pinned head/base; do not
create another PR. If its run is `action_required`, inspect and approve only
that reviewed run with
`gh api --method POST "repos/xandreeddev/efferent/actions/runs/<run-id>/approve"`,
then wait for its required check. Existing release authorization covers this
handoff; do not request it again. Verify the squash commit author is
`Xand Reed <xandreed@proton.me>`; never rewrite main or a published release to
repair historical authorship.

To request an authorized patch through CI when no changesets are pending:

```sh
gh workflow run release-pr.yml --repo xandreeddev/efferent --ref main -f patch=true
```

This records a patch intent in CI and prepares the usual shared-version PR.
The helper refuses pending notes so it cannot turn a patch request into a
minor or major release. Review and merge that PR normally; publication starts
after its merged source passes CI. `bun run release:patch` only records the
intent locally and is also used by that workflow.

For the already prepared `0.21.1` release, or to retry an interrupted release,
run the workflow on GitHub's Actions tab, or dispatch it:

```sh
gh workflow run release.yml --ref main -f version=0.21.1
```

The workflow resolves the original `release <version>` commit on main,
checks its exact successful CI run, and publishes that clean source even
when the pipeline code has advanced. If history contains more than one
release commit for that version, pass `-f commit=<full-sha>` explicitly.
Publication never runs from an arbitrary PR or a commit outside main.

### npm authentication

The first publication of new package names needs an npm granular token.
Create a short-lived token with package/scope read and write (publish and
stage), access to `@xandreed`, and bypass 2FA. Save it directly as the
repository Actions secret `NPM_TOKEN`; do not put it in a file or a PR.
Package settings must permit token publication. A stage-only token does not
perform this workflow's direct publication.

For ongoing releases, configure npm trusted publishing for each package:
GitHub owner `xandreeddev`, repository `efferent`, workflow `release.yml`,
with permission to publish directly. No environment name is required by
this workflow. Use npm's current trusted-publisher setup instructions,
then remove `NPM_TOKEN`. The job grants `id-token: write` and uses npm
11.15.0 on Node 24. npm automatically uses OIDC when no token is supplied;
`npm whoami` does not validate OIDC, so CI checks that account only for
explicit token authentication. Local publishing retains its account check.

Also configure that trusted publisher for the unscoped `efferent` package.
It reserves the project's npm name and publishes only the release README,
license and package metadata. Its separate `landing` job runs after the
framework release, using the same verified version and source commit. The
README points to the scoped framework packages; its repository links target
that exact source commit so they also work on npm. It has no runtime API,
commands or dependencies. Versions through 0.6.1 contain the historical CLI.

To inspect the landing package locally without uploading:

```sh
bun run publish:landing
```

This builds and packs the isolated `.artifacts/npm-landing` directory.
Uploads require `--ci --publish` and run through `release.yml`. Retrying an
existing release skips the landing version only when both its source commit
and packed integrity match. A retry can add a missing landing version
without republishing the framework packages or moving the release tag.

The final CI audit checks all 25 names for the release version, source commit
and archive integrity metadata, and reports whether provenance is present.
To repeat it from a checkout of the release source:

```sh
bun run release:status --root <release-checkout> --wait 180
```

The audit only reads the public registry. It handles propagation delays and
returns a failure for missing or mismatched packages. Add `--require-provenance`
to require attestation metadata for every package when testing trusted
publishing. The `trusted-publishing` skill in `.agents/skills/` describes the
activation and recovery procedure.

See [npm token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
Tokens are a bootstrap path; npm's direct token-publishing policy changes
in January 2027 make trusted publishing the ongoing path.

### Integrity and recovery

The publisher keeps the build/HEAD, clean-tree, shared-version, dependency
order and immutable-tag checks. Built manifests record `gitHead` and the
repository URL. An existing release can resume only when npm's core version
records the same source commit. Missing provenance cannot establish a safe
resume, and another same-version checkout is refused.

Every registry read and upload uses `https://registry.npmjs.org` explicitly.
After an ambiguous npm failure, the publisher checks the registry for about
three minutes before deciding whether the upload succeeded. Before tagging, it
asks for every package for up to about fifteen minutes, because a fresh version
can stay hidden behind the registry's CDN for several minutes. A retry uses the same
source commit and skips versions already uploaded. It never moves a pushed
release tag. The workflow uses one publication concurrency group and does
not cancel a release in progress.

The source and pipeline checkouts are separate, so a historical release can
use the current CI publisher without changing its source or build stamp.
The maintainer-owned release PR supplies its `pull_request` CI. Tags pushed with
`GITHUB_TOKEN` still need an explicit `docs.yml` dispatch on the published tag,
after all framework npm versions are confirmed.
For historical checkouts, the package's `gitHead` records the verified release
source. npm's provenance signs the archive digest and identifies the actual
publishing workflow commit. Keep GitHub's environment values unchanged:
the signing certificate binds that workflow SHA, so substituting a historical
source SHA makes npm reject the provenance. The source checks, manifest and
immutable README links record the separate release input.

`bun run release:publish` remains available for an explicitly requested
interactive recovery. Routine releases and the initial release above run
through GitHub Actions.

## Distribution changes

Run `bun run build:packages` and then `bun run verify:packages` for package
changes. `verify:packages` checks only the build of `HEAD` (`build.json`)
from a clean tree, and refuses test code in it (`*.test.*`, `testing`
modules and folders, which the build leaves out); to check a build of
uncommitted changes, run `bun run verify:packages --allow-dirty` right after
`bun run build:packages`. It then compares each published entry's exports
with `api/` and names every line that differs (`bun run api:update` rewrites
it), and checks the consumer installed exactly one copy of `@xandreed/core`
and of `effect`. The external-consumer test installs local tarballs; it
never publishes them.

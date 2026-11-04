---
name: trusted-publishing
description: Activate and verify Efferent's npm trusted publishers through CI patch releases, and diagnose or resume a partial publication. Use for package publishing permissions and registry verification.
---

# Verify npm trusted publishing

Use this with `../release/SKILL.md` for an authorized publication. A user's
request to perform a particular release authorizes its normal CI steps and
retries from that source; do not ask for the same approval again. Do not
publish a different version to work around a permission failure.

## Package scope and settings

The 24 framework names in `scripts/release-version-plan.ts` share a version.
The unscoped `efferent` name is the 25th publication, containing documentation.
It is separate from the Changesets fixed group.

Each npm package needs its own trusted publisher. Use GitHub owner
`xandreeddev`, repository `efferent`, workflow filename `release.yml`, no
environment, and permission for direct `npm publish`. Filename spelling and
extension must match exactly. Saved connections cannot be edited; replace an
incorrect connection through the maintainer's authenticated npm session.
Never ask for credentials or tokens in chat.

New trust configurations must complete their first successful publication
within npm's activation window, currently two days. Follow any shorter
maintainer deadline. Check current [npm documentation](https://docs.npmjs.com/trusted-publishers/)
when relying on this window or changing publisher settings. Existing package
versions cannot activate a new connection by being checked or skipped.
`npm whoami` cannot verify OIDC permissions; an actual publication is needed.
Before an activation test, inspect secret names with `gh secret list --repo
xandreeddev/efferent` and confirm the publisher uses OIDC without `NPM_TOKEN`.
A token can also publish with provenance, so attestation metadata alone is
not proof that a trusted connection was exercised. If a token is present,
use a CI run that omits it; do not delete a credential as a default action.

## Release through CI

For an authorized patch when no changesets are pending:

```sh
gh workflow run release-pr.yml --repo xandreeddev/efferent --ref main -f patch=true
```

This records patch intent in CI, then runs the existing Changesets versioner.
The helper refuses pending notes instead of consuming an unrelated version
change. Review the generated `release <version>` PR: the 24 manifests, plugin
versions, lockfile, documentation and new journal/run fixtures must agree.
Preserve existing released fixtures. Before squashing, use CONTRIBUTING.md's
maintainer-owned release PR handoff, retaining the reviewed head/base and title.
Do not merge or reopen the bot preview as the final PR: that keeps its author.
Wait for the new maintainer-owned PR's required `pull_request` CI; dispatched
workflow jobs do not satisfy it. Main's successful CI then starts `release.yml`.

The publisher uploads framework packages in dependency order, confirms the
registry, creates the immutable release tag and GitHub release, dispatches docs,
then publishes the `efferent` README package. A failure can leave a partial
publication; report the actual package results, not just a workflow status.
Check the separate `docs.yml` run before reporting documentation deployed.

## Confirm and recover

From a checkout of the exact release source, run:

```sh
bun run release:status --root <release-checkout> --wait 180 --require-provenance
```

The read-only audit checks all 25 names for the expected version, source SHA
and integrity metadata. The provenance flag requires attestation metadata;
inspect the signed bundle when investigating what a particular attestation
claims. Omitting the flag permits auditing historical releases without
attestations and still reports their presence.

If npm refuses authentication or publication permission, identify the package
from the failed job and correct its owner, repository, filename or allowed
action on npm. Resume the same workflow or dispatch `release.yml` for the same
version and original commit. Existing versions are skipped only after source
validation; the README package also checks the exact archive integrity.
Never move a tag or overwrite a package version.

If npm reports success but a registry endpoint remains stale, audit with the
bounded wait before retrying. When the exact version becomes visible, rerun
the failed job so its resume checks can confirm the accepted upload.

Preserve GitHub's authentic environment, including `GITHUB_SHA`, for npm's
signed provenance. Its certificate binds the running workflow commit.
Historical release inputs remain in the verified package `gitHead` and README
source links; substituting that SHA into GitHub's fields causes npm E422.

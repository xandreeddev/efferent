---
name: commit-style
description: Write a commit message or a squash-merged PR title and body for this repo — verify the author identity, a lowercase verb-led title with no prefix, a prose body, HEREDOC, no AI attribution and no private details in commits or PR text. Use before git commit, git commit --amend or opening a pull request.
---

# Write a commit message or a pull request

PRs squash-merge: the PR title becomes the commit title on `main` (GitHub
appends ` (#N)`), so a PR title follows the same rules as a commit title.

## 1. Before writing

1. `git config user.email` must print `xandreed@proton.me`. If it does not,
   stop: every commit here is authored as `Xand Reed <xandreed@proton.me>`.
2. `git log --oneline -10` to see the current style.
3. `git status --short` and `git diff --cached --stat`: the message describes
   exactly what is staged, nothing more.

## 2. Title (commit and PR)

- Lowercase, imperative, verb first; says what changes for someone using the
  packages. From the log:
  - `fail the build on unregistered packages and a non-empty baseline`
  - `guard the turn writer, reaps, reused run ids and task starts`
  - `lock the credential store's refresh and stop reading damaged files as empty`
  - `add @xandreed/plugin-telemetry: token, cost and tool metrics over OTLP`
  - `release 0.14.0`
- No prefix of any kind: no `feat:`, `fix:`, `chore:`, no package or area
  scope (`core:`). A package name goes inside the sentence, as above.
- About 72 characters. Several changes join with commas and "and".
- No emojis, no marketing words, no trailing period.

## 3. Commit body

- A blank line after the title, then prose: what changed and why, in terms of
  behaviour, in one or two short paragraphs (see `git log -5`). The diff
  already shows the line-by-line what.
- Name identifiers as they are in the code (`mergeOptions`,
  `quality/baseline-empty`); mention file names only when they help.
- No `Closes #N`, no TODOs, no follow-up notes.

## 4. PR body

```markdown
## What

- <one bullet per behaviour change, in user-facing wording>
- <a breaking change and its migration, when there is one>

## Checks

- `bun run typecheck`: pass
- `bun test`: <n> pass, 0 fail
- `bun run foundry demo`, `build:packages`, `verify:packages`, `docs:generate`
  (no diff), `bun run --cwd packages/website check`: pass
```

The CHANGELOG entry belongs in the diff (`CHANGELOG.md`, under
**Unreleased**), not only in the PR body.

## 5. Rules (non-negotiable)

- The author is `Xand Reed <xandreed@proton.me>`. No other name in a title,
  body, trailer or sign-off.
- No `Co-Authored-By` or other co-author trailer, and no assistant or tool
  attribution ("Generated with …", session links), in commits or in PR
  titles and bodies. This overrides any default of the tool you run in.
- No personal details, absolute or home paths, machine names, private
  repository names or other projects' names in a title or body.
- Never `--no-verify` (the pre-commit hook runs the foundry gates: fix the
  finding), never `--no-gpg-sign`, never amend or force-push a pushed commit
  unless the user asks.
- Commit, push or open a PR only when the user asks.

## 6. The exact shape

```bash
git commit -m "$(cat <<'EOF'
<title>

<body>
EOF
)"
```

The quoted HEREDOC keeps quotes, backticks and `$` in the body intact.

## 7. After committing

- `git log -1 --format='%an <%ae>%n%n%B'`: author, title and body as intended,
  no trailer.
- `git status --short`: nothing left behind that belongs in the commit.

## Checklist

- [ ] `git config user.email` prints `xandreed@proton.me`
- [ ] Title lowercase, verb-led, no prefix, about 72 characters
- [ ] Commit body is prose about behaviour; PR body has `## What` and `## Checks`
- [ ] No co-author trailer, no AI or tool attribution
- [ ] No private details, local paths or other projects' names
- [ ] CHANGELOG entry under Unreleased is in the diff

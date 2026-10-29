---
name: commit-style
description: How to write a commit message for this repo — verify alias git identity, follow the lowercase verb-led title style, use HEREDOC, and never add Co-Authored-By. Read this whenever you're about to write or propose a commit message.
---

# Write a commit message for this repo

## Before composing

1. Run `git config user.email`. It MUST return `xandreed@proton.me`. If not, stop: every commit in this repository is authored by that identity.
2. Run `git log --oneline -5` to refresh your memory of recent style.
3. Run `git status --short` and `git diff --stat HEAD` to make sure the staged set matches what you intend to describe.

## Title

- Lowercase, action-verb-led. Examples from the log:
  - `pivot CLI from notes to no-compromise coding agent`
  - `tui: split pane with live log feed, captured console, status notes`
  - `add skills system + split LLM ports into focused tiers + TUI polish`
- No Conventional Commits prefix (no `feat:`, `fix:`, `chore:` — except matching what the log already does). Optional short capability prefix like `tui:` only when it genuinely helps locate the change.
- Aim for ≤ 72 chars; longer is fine if it reads better.
- No emojis. No marketing.

## Body

- Blank line after the title, then prose explaining the *why* and the conceptual shape of the change. Skip the line-by-line what; the diff already shows that.
- If the commit spans multiple themes (e.g. a port refactor + a new feature), use short hanging sub-headings to group them.
- Reference filenames sparingly.
- No `Closes #N`, no TODOs, no follow-up notes — those belong in tickets or PRs.

## Rules (non-negotiable)

- All authoring is `Xand Reed <xandreed@proton.me>`; no other names in the title, body or signoff.
- Never add `Co-Authored-By`, AI attribution, or assistant/vendor signoffs.
- Never use `--no-verify` to skip hooks. Never `--amend` a published commit unless the user explicitly asks. Never `--no-gpg-sign`.
- Never include local paths or the names of other projects.

## The exact shape

```
git commit -m "$(cat <<'EOF'
<title>

<body — prose, multi-paragraph OK, sub-headings OK>

EOF
)"
```

The HEREDOC matters: without it, multi-line messages and quotes inside the body get mangled by the shell.

## After committing

- Run `git status --short` to confirm clean.
- Run `git log -1` to eyeball the result.
- Do not push unless the user asked.

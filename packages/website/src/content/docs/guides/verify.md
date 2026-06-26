---
title: Verifying a build
description: efferent verify — a graded, LLM-driven acceptance battery that validates a target (this tree, a commit, or a published release) end to end.
sidebar:
  label: Verifying a build
  order: 10
---

`efferent verify` runs a **graded acceptance battery** against a *target* — the current
working tree, a specific commit, or a published npm release — and tells you, in one
command, whether the whole thing still works: boot, the internal UI flows, the daemon, the
in-process coder, and the headless modes. It's deterministic where it can be and uses a cheap
LLM (`opencode:deepseek-v4-flash` by default) only where a real turn is genuinely needed.

```bash
efferent verify                              # this working tree, all tiers
efferent verify --target source --tier A     # deterministic checks only (no key)
efferent verify --target commit:<sha>        # a checked-out commit (throwaway worktree)
efferent verify --target release:0.2.0       # a clean-room npm install in Docker
efferent verify --model opencode:deepseek-v4-pro   # override the model
efferent verify --json                       # machine-readable report
```

## The three tiers

Each check declares a **tier**, so determinism is explicit. The process exits non-zero **only**
when a *hard* check fails — a `skip` (n/a, e.g. no credential) or a `soft` (best-effort, e.g. a
semantic smoke) never fails the run.

| Tier | What it does | Needs a key? |
| --- | --- | --- |
| **A · deterministic** | `--version`/`--help`/subcommand parse, the no-provider gate, the **internal UI flows** (onboarding, `:login`, `:model` — driven headlessly with the real renderer), and the daemon lifecycle (`start` → healthy → `/health` → `stop`). Never flaky. | no |
| **B · agent · objective** | Real keyed turns on the cheap model through the **in-process** path (`--mode json`), the **daemon** (over HTTP), and **rpc**. Each asserts an objective *side-effect* — a file on disk + a successful tool call — never prose. | yes (skips cleanly without) |
| **C · judge · semantic** | A curated, cheap subset of the [eval suites](/docs/guides/evals-guide/) (`tool-selection`, `session-title`, `judge-approval`) graded by an independent judge. Soft by default; `--strict` makes it hard. | yes |

`--tier <A\|B\|C\|all>` picks the highest tier to run (Tier A always runs — it's the backbone).
The UI-flow tests are ordinary `testRender` bun tests, so they also run in CI under `bun test`.

## Targets

- **`source`** (default) — runs the full typed tiers over the working tree.
- **`commit:<sha>`** — checks the commit out into a throwaway `git worktree`, `bun install`s it, and
  runs there.
- **`release:<ver>`** / **`npm:<spec>`** — builds a clean-room Docker image with `npm i -g
  efferent@<ver>` and runs the install-integrity + keyed battery inside it (the UI-flow tier needs a
  source tree, so it's reported as skipped there).

Credentials are read from `~/.efferent/auth.json` (the same place `:login` writes them) — never from
env vars on the local path, and never baked into the Docker image (the host's `auth.json` is copied
into the running container at run time, not the image).

## Running the eval suites directly

`efferent eval` is first-class access to the eval suites (forwarded to the evals runner; runs from a
source checkout):

```bash
efferent eval tool-selection --main opencode:deepseek-v4-flash --json
efferent eval                        # all suites
```

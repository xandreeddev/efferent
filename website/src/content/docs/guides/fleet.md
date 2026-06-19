---
title: Run a fleet
description: From your first agent role to a coordinated, goal-directed, scheduled network — define agents and tools as git-shareable files, fire them from a live session, let them talk, and keep them running headless.
sidebar:
  label: Run a fleet
  order: 7
---

A **fleet** is what a single `run_agent` grows into once agents are *named*: a network of
specialised agents you fire from a live session, that coordinate over a shared bus, pursue a
standing goal, and run on a schedule. This guide takes you from one role file to the whole
cockpit. For how it works under the hood, see the [Fleet concept](/docs/concepts/fleet/);
this page is about *doing* it.

Everything here builds on [sub-agents & the context tree](/docs/concepts/sub-agents/) — a fleet
member is a sub-agent with an identity.

## 1 · Your first agent role

A **role** is a markdown file in `.efferent/agents/`. Frontmatter declares the name, an optional
model, and an optional tool allowlist; the body is the role's system-prompt instructions.

```markdown
---
name: reviewer
description: Reviews a diff or files for correctness bugs and cleanups
model: anthropic:claude-opus-4-8     # optional — omit to inherit the session model
tools: read_file, grep, glob, ls, Bash   # optional allowlist — omit for all base tools
---
You are a meticulous code reviewer. Read the changed files, then report findings as
`path:line — issue` lines in two buckets: correctness bugs, then cleanups. You read; you
do not edit.
```

Drop it at `<project>/.efferent/agents/reviewer.md` (per-project) or `~/.efferent/agents/` (global) —
the same `cwd → parents → home` search as skills; closer-to-cwd wins on a name clash.

Now fire it from a running session:

```
:spawn reviewer packages/sdk-core "review the ports for missing error handling"
```

The agent runs **alongside** your conversation (the composer stays free), shows up in `:tree`,
and streams in the activity pane. The model can delegate to it too:

```
run_agent({ name: "review core", agent: "reviewer", folder: "packages/sdk-core", task: "…" })
```

:::tip[What the role controls]
The role's **body** becomes the sub-agent's instructions (wrapped by the usual scope + return
contract, so write-confinement still holds), its **`tools`** list restricts the toolkit
(omit for all base tools — `run_agent` is excluded from a role unless you name it), and its
**`model`** overrides just that run's model. Name an unknown role and you get a model-facing
`UnknownAgent` error listing what's available.
:::

`:agents` lists the loaded roles; `:stop <id>` cancels a running one (`:stop` with no id lists them).

## 2 · Share roles over git

Roles are plain files, so they travel. Pull one (or a whole directory) straight from GitHub —
no npm, no install step:

```
:agents add github:xandreeddev/efferent/examples/agents/reviewer.md
:agents add github:xandreeddev/efferent/examples/agents        # every .md in the dir
```

Imported files are validated, written into `<cwd>/.efferent/agents/`, and apply on the next
launch. `@ref` selects a branch/tag/sha: `…/reviewer.md@v2`.

## 3 · Declarative tools

Tools travel the same way. A **declarative tool** is a markdown file in `.efferent/tools/` — a
command (or URL) template with `${param}` placeholders, run by the generic `run_tool`:

```markdown
---
name: find_todos
description: List TODO/FIXME/HACK comments under a directory
type: shell                       # shell | http
command: bash -lc 'grep -rnE "TODO|FIXME|HACK" ${dir} || echo none'
params: dir: directory to scan
timeout: 20
---
```

The model calls it by name, passing params as a JSON-object string:

```
run_tool({ name: "find_todos", args: '{"dir":"src"}' })
```

Param values are escaped for the target (shell-quote / URL-encode), so a value can't break
out of the template. **Shell** tools run through the same bash gate as the built-in `Bash`
(allow-bash + the approval prompt); **http** tools do a GET via the Http port.

`:tools` lists them; `:tools add github:owner/repo/path` imports them.

:::caution[Trust]
An imported shell tool *executes* — review it like any dependency. Shell tools still prompt
for approval in the TUI and need `--allow-bash` headless; the command template is fixed by the
file (only param values vary, and they're escaped).
:::

## 4 · A network: parallel work + coordination

Fire several agents in disjoint folders and they run **in parallel** (same-folder spawns
serialize on a lock — write-safe by construction). To keep them from duplicating or clobbering
each other, they coordinate over the in-memory bus:

```
blackboard_post({ note: "I own the SQLite adapter; leave migrations to me" })
blackboard_read({})                       # what siblings have posted
send_message({ to: "<nodeId>", content: "the schema changed — re-read before editing" })
```

`send_message` targets a **running** agent by the `nodeId` a `run_agent` call returned; the
recipient reads it at the start of its next turn (it arrives as an `[inbox · message from …]`
line). A message to a finished agent fails fast.

**You** can message a running agent too: open it in `:tree` (`↵`), and anything you type goes
to its mailbox — it reads at its next turn, and your composer stays free. (Type into a
*finished* node and it resumes in place instead.)

## 5 · Give the fleet a goal

A **directive** is a standing objective that rides every turn until it's met — not a one-shot
prompt:

```
:goal get the eval suite to 95% passing :: bun run eval shows ≥0.95 mean, no suite below 0.8
:goal                                     # show the current directive
:goal clear                               # drop it
```

The text after `::` is the acceptance criteria. The lead agent (with the directive in context,
plus `run_agent` and the bus) is the supervisor. To check completion, spawn the built-in
**verifier** — a strict, read-only judge in a *fresh* context (so it never grades its own work):

```
:verify                                   # judge the current goal
:verify "the login flow handles expired tokens"   # judge an ad-hoc objective
```

It reports `MET` / `NOT MET` / `INCONCLUSIVE` with evidence. The model can also call
`run_agent({ agent: "verifier", … })` itself.

## 6 · Schedule work

Cron a job — recurring or one-off — with a 5-field expression:

```
:schedule add 0 9 * * 1 :: . :: review the open PRs and post a summary
:schedule add */30 * * * * :: src :: sweep new TODOs :: reviewer    # run as a role
:schedule                                 # list this workspace's jobs
:schedule rm <id>                         # drop one
```

Format is `<cron> :: <folder> :: <prompt> [:: <agent>]`. Jobs persist in `~/.efferent/cron.json`
and fire as fresh agent runs while efferent is open.

To keep them firing **without** a TUI open, run the headless daemon:

```bash
efferent --mode daemon --cwd /path/to/project
```

It runs the scheduler forever, firing this workspace's due jobs as persisted runs (visible later
in `:tree` / `:sessions`). Needs a credential already in `~/.efferent/auth.json`.

## 7 · The cockpit

`:fleet` is the at-a-glance readout — the standing directive, the live fired agents, and this
workspace's scheduled jobs, plus the verb reference:

```
── fleet ──
directive: get the eval suite to 95% passing — done when bun run eval shows ≥0.95 mean
running agents: #2 reviewer (packages/sdk-core), #3 docs-writer (docs)
scheduled: 0 9 * * 1 → review the open PRs · */30 * * * * → sweep new TODOs
verbs: :spawn · :stop <id> · :goal · :verify · :schedule · :tree · :agents · :tools
```

The header's `◆ N agents` chip tracks the live fleet continuously, and `:tree` browses the full
run tree — preview any node, fork it into a new session, or resume it.

## Bounds & safety

The fleet inherits every sub-agent guardrail, and they apply across the whole network:

| Bound | Default | Tune |
| --- | --- | --- |
| Spawn depth | 2 | `:set subAgentMaxSteps` is per-run; depth is fixed |
| Steps per agent | 80 | `:set subAgentMaxSteps <n>` |
| Shared token budget | 1M / turn subtree | `:set subAgentTokenBudget <n>` (`0` = off) |
| Same-folder writes | serialized on a per-folder lock | — |
| Bash (incl. shell tools) | approval prompt + `--allow-bash` | `:set autoApprove off` for always-ask |

`Esc` interrupts the whole subtree — structured concurrency, no orphans. See
[Settings](/docs/reference/settings/) for the full knob list, and the
[Fleet concept](/docs/concepts/fleet/) for how it's all wired.

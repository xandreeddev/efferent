---
title: Smith
description: The direct coding preset for the composable Efferent harness.
---

# Smith

`bun run efferent` opens Smith. A controller inspects the task, delegates bounded
edits to an editor, reviews the staged proposal, applies it and runs checks.
Both roles use the same configurable plugin graph and shared turn budget.

The configured main model drives the controller; fast drives the editor, falling
back to the controller. `/models` chooses each role. `--driver-model provider:model` and
`--editor-model provider:model` override them for an invocation. `/plugins`
edits options and `/login` connects a provider.

Jev selects direct work or internal planning for each request from the current
message and recent conversation. Configure the planning plugin's gateway key,
or its System One endpoint to reuse an OpenCode credential. An unavailable
decision records a conservative planning fallback. `/plan` separately switches
to read-only work; `/code` enables edits.

`/mods` selects optional Effect 4 expertise: foundations, Schema, services,
concurrency, AI and architecture. `--profile effect` enables all six versioned
prompt modules. The general profile starts without them.

The conversation stays in focus. `/context`, `/tasks`, `/changes` and `/checks`
open inspectors; `/sessions` resumes previous work. Ctrl+O inspects activity.

Enter sends, Shift+Enter inserts a newline and Ctrl+P opens commands. Escape
dismisses an overlay and preserves the draft; Ctrl+U clears input. Text entered
during a run is queued as steering input. Escape cancels active work when no
overlay is open; Ctrl+C interrupts and a second Ctrl+C exits.

Use `/spec idea` to draft with read-only tools, `/lock` to approve the draft,
and `/forge` to implement under Foundry gates. The workflow is a plugin and
delegates to its configurable workflow worker. It records drafts, locks, gate reports
and outcomes in the durable session. Host gate execution asks for approval.

The historical workflow driver remains `bun run smith:workflow` for old specs.

`bun run evals:smith:check` or `bun run scenarios smith-coding smith-interaction`
runs native Smith calibrations through `@xandreed/evals`. Fresh candidate
services execute the
production coding and conversation paths; evaluators score retained evidence,
and blocking gates require acceptance, architecture and interaction checks to
pass. Provider and Jev HTTP are scripted for these regressions. They add no
legacy scenario baselines, and `--no-check` cannot bypass their gates.
The four coding and three interaction cases are known contract fixtures in
disjoint calibration and validation families. Both splits run; these fixtures
do not establish unseen model quality, recommend a model or promote its
quality. Reference labels reach only evaluators.

`bun run evals:smith` runs the repeated coding calibration. Live comparison
requires explicit `--live --main provider:model --fast provider:model`
configuration and request/spend admission. Reports retain native calibration,
trial and assessment records, production evidence and gate findings. Scripted
success proves wiring; model-quality and cost claims require live evidence.

See the [SDK guide](/docs/concepts/harness) for composition and policy.

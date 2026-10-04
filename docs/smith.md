# Smith coding agent

Smith's default preset composes the existing `Harness` and `Agent` runtime with
replaceable model, memory-window, discovery, step-loop, coding, planning and
Effect-module plugins. The coding loop receives the host's admitted
`ActiveTurnWriter`; it reuses the host's admitted parent turn and configured
plugin services. The host owns queuing, cancellation and settlement.

The controller uses the configured main model. The editor uses fast, falling
back to the controller. `/models`, `--driver-model` and `--editor-model` select explicit
role overrides. A turn pins its graph, models and enabled modules; saved
changes take effect on the next turn.

Vercel AI Gateway runs through the shared `plugin-models` adapter and Efferent's
native Effect AI model port. Use `/login vercel` or `AI_GATEWAY_API_KEY`, then
select `vercel:deepseek/deepseek-v4.1-flash` for the base model and editor.
Saved Gateway credentials also enable Jev's per-request planning decision.
Controller and editor model overrides remain independent.

The editor runs in a scoped child session with a concrete work order, allowed
paths and applicable workspace instructions. Its file tools stage an overlay.
`submit_edits` produces a Schema-validated proposal; the controller reviews and
applies it. Original-content fingerprints reject stale proposals before
mutation. Workspace writers are serialized, paths stay within the workspace,
and verification runs with source files read-only and network disabled.
The controller receives actual check exit codes and output. Failed cheap-editor
attempts escalate to the controller model within the same turn budget.

`maxModelRequests`, `budgetMillis`, `budgetTokens`, `maxOutputTokens`,
`editorMaxSteps` and `maxEditorAttempts` configure the coding instance. The
shared budget covers model steps and reported token usage from both roles,
including editor retries and escalation. A model step may include additional
HTTP requests from provider-owned retries or fallback. Context estimates and
output reservations are checked before each step; measured usage is recorded
afterward. Failed requests may have unreported usage. Live campaign admission
reserves each actual HTTP request separately, and subscription protocols that
ignore output caps have explicit request, input and time bounds without a
guaranteed output bound.

## Planning and Effect modules

Every request with `planningMode: "auto"` runs the versioned `smith.planning/1`
decision prompt through Jev. It receives the current message and recent
conversation, then selects `direct` or `plan`. Planning adds a system instruction
to plan implementation work internally and proceeds with the user's request.
It does not add a user message or turn greetings into inspection tasks.
Greetings receive brief direct replies. `/plan` separately
removes mutation and verification tools. Explicit `planningMode: "direct"` or
`"plan"` bypasses the classifier.

The planning plugin defaults to Vercel AI Gateway with `AI_GATEWAY_API_KEY`.
An OpenCode configuration can reuse its saved credential:

```json
{
  "id": "planning",
  "use": "@xandreed/smith/planning",
  "options": {
    "protocol": "systemone",
    "endpoint": "https://opencode.ai/zen/v1/systemone",
    "model": "jev-1.13",
    "apiKeyEnv": "OPENCODE_API_KEY",
    "apiKeyProvider": "opencode"
  }
}
```

Missing credentials, timeout and invalid answers record an unavailable decision
and use conservative internal planning when implementation is needed. They never
fabricate a Jev answer. The decision remains available in `/context` without
adding routing notices to the conversation.
Saved credentials are resolved for each decision; signing in again takes effect
on the next request without restarting Smith.
The default saved-key provider is `vercel`, matching the Gateway model route.
HTTP is injected through `SmithPlanningTransport`; the production prompt and
answer validation remain in use during deterministic evaluations. The two
protocols follow the [OpenCode endpoint](https://opencode.ai/docs/en/zen/#jev)
and [TypeSafe response contract](https://docs.typesafe.ai/api).

`/mods` toggles six optional, versioned prompt sections: foundations, schema,
services, concurrency, AI and architecture. `--profile effect` enables all of
them. They target the repository's installed Effect 4 dialect, native
`effect/ai`, Schema entities/value objects, Context.Service ports, Layer
adapters, immutable state and scoped Effect concurrency. The general Smith
profile starts with no Effect sections enabled.

## Terminal and session evidence

The main terminal shows the conversation, concise activity, model, mode and
elapsed time. `/context`, `/tasks`, `/changes` and `/checks` open on-demand
inspectors. Ctrl+O inspects transcript activity; Ctrl+P opens the command
palette. Escape dismisses an overlay while preserving the draft; Ctrl+U clears
the composer. Editor chatter stays out of the main conversation.
Tools and skills advertised to each model respect its current permissions.
Failed tools remain visible with a concise explanation; Ctrl+O retains their
arguments and bounded result previews alongside subsequent recovery. The journal
retains the complete results.
The composer starts in insert mode. Idle Escape enters normal mode with
`h/j/k/l`, `w/b`, `0/$`, `x` and `u`; `i/a/I/A` return to insert mode.
During a turn, Escape stops work. Menus and inspectors support `j/k`, `l` or
Enter to open, and `h` to go back. `/` starts filtering, Ctrl+J/K move through
filtered results, and Ctrl+G returns to browsing.

`SessionHandle.journalHistory` and `journal(after?)` expose the native log,
including immutable inherited prefixes, while legacy `history` and `events`
remain available. Live journal reads work during active turns. Historical
assistant/tool messages are projected into modern memory on read; old records
are retained and tools never replay just because a session resumes.
`--json` retains the legacy headless event format; `--journal-json` emits native
records. Session data stays under `.efferent/runtime`.

`/spec`, `/lock` and `/forge` temporarily compose the optional historical
workflow services and restore the coding configuration afterward. They are
separate from automatic internal planning. Former standard Smith tools settings
are translated in memory when the new coding loop is selected; local files,
model choices and custom loop replacements are preserved.

## Evaluations

Smith's new coding and interaction evaluations use native `@xandreed/evals`
calibrations, declared with `defineCalibration` and executed with
`runCalibration`. Each definition names its typed dataset, candidate codec,
subject, evaluators, blocking gates and run settings. Candidate services are
built fresh for each case; the subject receives inputs and produces output plus
evidence for scoring. Reference labels belong to evaluators.

`bun run scenarios` runs the native Smith evaluations and the repository's
remaining legacy scenario packs. `bun run evals:smith:check` or
`bun run scenarios smith-coding smith-interaction` selects both Smith
calibrations without provider credentials. Only external provider HTTP and
Jev HTTP are scripted; the real controller,
editor, tools, staging, application, memory and checks run. Coding cases use
independent executable acceptance tests and Effect 4 architecture checks.
Interaction cases exercise greetings, permissions and failed-read recovery.
Versioned deterministic evaluators require a pass rate of 1 for each blocking
contract metric; failed trials and infrastructure failures cannot be hidden by
an average score. `--no-check` does not bypass native calibration gates.
These evaluations add no retired Pack/Scenario definitions or legacy baseline
files.
Linux coding evaluations require Bubblewrap for Smith's sandboxed verification;
a missing or unavailable sandbox is a failed check, never a passing fixture.

The four coding cases and three interaction cases have known contract
references in disjoint calibration and validation families. Schema boundaries
and service isolation form the coding calibration split; concurrency and AI
failure recovery form its validation split. The greeting variants share a
calibration family, while failed-read recovery belongs to validation. Both
splits run as contract regressions; these known fixtures do not establish
unseen model quality. The subject receives the public task and fixture seed;
the scripted transport owns its solution fixture separately.
Only evaluators receive reference labels. Scripted runs make no candidate
recommendation or quality promotion.

`bun run evals:smith` runs the repeated deterministic coding calibration.
`bun run evals:smith --live --main provider:model --fast provider:model
--admit-subscription` explicitly starts live trials. The matrix compares a
controller-model editor against the configured editor over four cases with two
repetitions. Its admission records priced reservations under a $10 cap and
separate unpriced subscription bounds. Failures and retries retain their
reservations. Unsupported or unpriced API models are refused before dispatch.

Native reports retain calibration, dataset, evaluator, subject and candidate
identity, per-trial outcomes, metric coverage, gate findings and performance.
Each trial's evidence includes configuration and graph identity,
prompt/schema/protocol versions, parent and editor journals, transport requests,
measured usage, latency, resulting diffs and independent check results.
The coding matrix also writes a Schema-encoded `calibration.json` containing
both split reports, and native version 2 trial and assessment records alongside
its existing trial, summary and admission evidence under `.artifacts/evals/smith`.
Scripted transport success
establishes wiring and deterministic behavior; it does not measure comparative
model quality or cost. Live evidence is required for those claims, and any
candidate recommendation must follow the host's declared selection policy.
Per-role usage and spend admission remain separate from evaluator metrics.

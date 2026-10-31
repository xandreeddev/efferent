---
title: SDK and sessions
description: Define an agent from plugins, run its turns, and keep each conversation as a durable session.
---

# SDK and sessions

## Defining an agent

`Agent.define(config)` (from `@xandreed/sdk`) resolves the plugin graph and
activates its runtime plugins once, in the caller's scope. Each turn then runs
through `agent.turn`, with the turn's own services: the model, the `Sessions`
it is written to, and any per-turn host data.

```ts
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"

declare const model: LanguageModel.LanguageModel // from @xandreed/plugin-models or any effect/ai provider

const reply = Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(
    Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
  )), Sessions)
  const agent = yield* Agent.define({
    plugins: [{ plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } }, toolDiscoveryPlugin, stepLoopPlugin],
    turnServices: [LanguageModel.LanguageModel],
    system: "You are a helpful assistant.",
  })
  const view = yield* sessions.create({ owner: "user-1" })
  const outcome = yield* agent.turn({
    turn: { session: { id: view.header.id, owner: "user-1" }, userMessage: new UserMessage({ text: "Hello" }), runId: RunId.make(crypto.randomUUID()) },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }, (turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
  return outcome.reply
}))
```

`agent.turn` returns what `use` returned with the turn's token usage
(`outcome.usage`: every model call the step loop handled in the turn, cache
reads and writes and reasoning included). [Token usage](/docs/concepts/providers/#token-usage)
lists what it leaves out (utility calls, failed or retried attempts).

A turn that cannot begin fails with the refusal itself, before anything is
opened: `SessionBusy` (another turn is open; it names that turn),
`TurnDuplicate`, `KeyConflict`, `NotResumable`, `TurnRefused`… Handle one
with `Effect.catchTag("SessionBusy", (busy) => …)`; `harnessCodeOf` gives
the code it stands for (`session.busy`), and the
[event reference](/docs/concepts/event-reference/#begin-codes) suggests an
HTTP status for each.

A new turn may carry the host's metadata, `meta` (a request id, a tenant):
`turn: { session, userMessage, runId, key, meta }`. It is stored with the
turn's start, given to the host's `TurnAdmission`, and shown on
`turn.admitted`, `RunContext.admitted` and the `turn.started` event. The
model never sees it, and a retry with the same key and other metadata is
still the same turn (`turn.duplicate`).

A turn that was cancelled or interrupted (its process stopped, its lease
was reaped) can be resumed by the next one:
`turn: { session, userMessage, runId, resumes: 1 }`. Turn 1 must be the
session's last turn begun by a user, with only inbox turns (and resumes
of it that did not complete) after it, and must have ended cancelled or
interrupted; otherwise the turn fails to begin with `NotResumable`
(`turn.not-resumable`).
Memory keeps what turn 1 stored: its message, assistant tool calls stored before
their handlers, and each result as it returned. A call without a result is shown
as `ToolInterrupted`; `toolCallStatesOf` exposes its exact durable state. The
new turn's message may be the original message again or "Continue where you stopped.". That is
what a plain new turn would see too: `resumes` records which turn the new
one continues, and changes nothing the model is sent. A cancelled turn
stores no reply; an interrupted one may keep a failed reply with no text.
What a tool already did is not undone. The key defaults to `resume:1`, so a
retried resume is `turn.duplicate`; a resume that failed (its provider was
down, say) is tried again with a new key. The new turn's `admitted.resumes`
and its `turn.started` carry `1`. The framework guide's sessions section
has the rules and the keys in full.

A user's message can carry images:
`new UserMessage({ text, attachments: [image] })`, the text empty or not, an
image built with `mediaFromBytes(bytes)` or `mediaFromBase64(data)` from
`@xandreed/core` (PNG, JPEG, GIF or WebP, within `MEDIA_LIMITS`). The session
checks each image again from its bytes when the turn begins and stores it
inline, once, in the turn's start; an image it refuses fails the turn with
`AttachmentRejected` (`turn.attachment-rejected`, its `reason` and `index`
kept) before anything is stored. A tool returns images the
same way, as `Media` values in its result (its view's `media` picks which
are sent; every one by default); memory stores each once, where the tool put
it. The current turn's images (its message's, then its tool results', newest
first) are sent to the model first, within the memory plugins' `maxImages`
and `maxMediaChars` (with the defaults a message's own images always fit;
`maxMediaChars: 0` sends none); their `media` option says whether earlier
turns' images are sent too (`inline`, the default) or shown as a label line
(`none`). [Images](/docs/concepts/providers/#images) lists the routes that
take them: the others get a label line in place of each image.

The turn's stored end says how it ended: completed, partial or failed as
`use` returned it; failed with the error's own code (a `HarnessError`'s),
`turn.failed` (an error without a code) or `turn.defect`; or interrupted,
with `turn.interrupted`. `turnEndingOf(exit)` from `@xandreed/core` gives
that ending, for a host that ends turns itself. If storing the end of a
successful turn fails, the turn fails; an end that could not be stored is
tried again, with the same ending, when the writer's scope closes.

`budgetTokens` (on the agent, or per run in the policy; 64 000 by default)
is the target memory keeps each request under: the system prompt, the tool
schemas and the messages, estimated. It must be an integer of at least 1
(`config.budget`, `turn.budget`). At each step, what the system prompt and
tool schemas leave of it is what the memory strategy fits the messages
into; when they leave nothing, the step fails with `context.budget`. Every
step's `context.built` event records it. The [event reference](/docs/concepts/event-reference/)
lists the framework's stored failure codes; a turn that fails with a
host's or a plugin's error stores that error's code.

Memory strategies use version 2 decisions. Summaries default to
`summarizeAt: "turn-end"`: after each successful `turn.run`, including a partial
return, before that call returns to the host. Choose `"step"` for pre-request
timing. Failed or interrupted runs skip normal end maintenance. Summaries retain
whole turns and protect the active admitted turn; end maintenance removes its
obsolete temporary step context from estimates.

On a classified context overflow, the SDK can compact to a strictly smaller
request and resend once per step. Recovery uses the existing `budgetTokens`
and known model limits; its run ceiling only shrinks. It preserves the frozen
step choice and records a new request header before dispatch. Protected current
history or a failed reduction keeps the original overflow. Once a nonempty
streamed assistant delta is visible, recovery declines so it cannot silently
repeat the answer. Failed attempts and summary helpers stay in billed usage;
selected usage includes accepted responses only. Custom loops honor the optional
`StepRequest.onContextOverflow` hook and rerun `stepLoopConformance`.

Accepted positive input counts can raise message estimates through
`scaledTokens`, using the exact prepared message estimate and system/tool reserve.
The SDK matches the actual selected model and run; helpers, discarded responses
and aggregate billed usage do not calibrate context. Missing evidence keeps the
raw estimate. Stored estimates and version 1 replay remain unchanged.

Manual compositions use `prepareRun(policy, options)` from `@xandreed/sdk`, run
`loop.run(prepared.request)`, then execute the cached `prepared.afterRun` on
success. `runTurnLoop` does this automatically; `stepRequestOf` stays a
preparation-only API. No extra scope service is required. A host can run the loop
several times before choosing its turn reply; each run owns its maintenance.

Each admitted turn runs under an `agent.turn` span carrying
`efferent.session.id`, `efferent.run.id` and `efferent.turn`, which every
span under it repeats (the step loop's `engine.run` and `engine.turn`, the
model call, each `loop.tool_call` with its `tool.<name>` and the handler's
own spans, each nested where it runs). It ends with `efferent.outcome`, the failure's code and the
turn's usage, and the metrics `efferent.turns` and `efferent.turn.duration`
count it by outcome. The turn's metadata reaches the span only for the keys
the agent names in `spanMeta`, and prompts and responses only when a run
captures trace content (`captureTraceContent` on the agent or the policy;
off by default). A turn `Agent.turn` begins itself begins under an
`agent.turn.begin` span beside it, around the session-scoped plugins'
activation and `Sessions.begin`: it ends with `efferent.turn` once the turn
begins, or with the refusal's code (`efferent.failure.code`) when it cannot
(such a turn has no `agent.turn`). The turn's logs carry the same ids as
annotations (a log written while it begins, the session and run ids). A
host composing its own turn gets the same spans with
`traceTurnBegin({ session, runId, origin })` around its begin and
`traceTurn(writer)` around the rest. Spans and metrics are exported by
whatever exporter the host provides around its program, such as `OtlpTelemetryLive` from
`@xandreed/plugin-telemetry`, whose `telemetryPlugin` also records each
turn's usage, cost and tool metrics (see [observability](/docs/concepts/observability/)).

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere.
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores
them in a SQLite file on Bun, which records its schema version: opening it
upgrades an older file, and a file a newer release wrote fails to open with
`store.version`. Any other store can implement the `SessionLog` port.

## Plugins

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies (and the fiber's settings:
logging, tracing and the current span, the clock); a host service it does not
declare is not there, even one provided around `Agent.define` or `Agent.turn`.
`definePlugin` holds the layer to its declaration: a layer that needs a
service `requires` does not list does not compile (a Reference needs no
entry), a service in `optional` is read with `Effect.serviceOption`, and an
activation that lacks a required service fails with `requires.missing`.
Two providers of a service require a `bindings` entry selecting the instance
id. Runtime plugins cannot require session services. Dependencies are checked
before activation, and a failed activation closes its partially acquired
scope. An agent whose turns would have no memory, tool registry or step loop
is refused by `Agent.define` (`config.graph`, naming the missing service).

A tool declares the services its handler reads too (`defineTool`'s
`requires`; a handler that reads another does not compile), and a turn whose
services lack one fails to open its tools with `requires.missing`, naming
the tool and the service, before its first step. A prompt section that reads
services is built with `definePromptSection` and lists them the same way; a
turn that renders it without one fails with `requires.missing`, naming the
section and the service.

Options are given as `{ plugin, options }` entries in `Agent.define({ plugins })`.
They merge over the plugin's defaults, nested objects key by key (an array,
or an object of another of the shapes the schema allows, replaces its
default), and decode through its schema; undeclared keys are refused. The [plugin reference](/docs/concepts/plugin-reference/)
lists every first-party plugin's defaults and schema.

## Skills

A skill is a catalogue line the model always sees, instructions it loads
on demand (`load_skill`) and reference documents it reads after that
(`read_skill_reference`); `@xandreed/plugin-tool-discovery` serves all
three. A host defines skills in code (`defineSkill`) or as files: a
directory with a `SKILL.md` in it, the Agent Skills layout.

```md
---
name: commit-style
description: How to write a commit message in this repository.
---

Lowercase, verb-led titles. Examples are in references/examples.md.
```

`skillsDirectoryPlugin` from `@xandreed/plugin-workspace` reads such
directories once, when the agent is defined, through the `FileSystem`
port (`localSystemPlugin` provides the local disk):

```ts
import { localSystemPlugin, skillsDirectoryPlugin } from "@xandreed/plugin-workspace"

const agent = yield* Agent.define({
  plugins: [localSystemPlugin, skillsDirectoryPlugin, memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  turnServices: [LanguageModel.LanguageModel],
  workspace: "/srv/project",                 // .agents/skills is read from here
})
```

- **Where.** `roots` (default `[".agents/skills"]`) are absolute or relative
  to the agent's `workspace`. Every `SKILL.md` below a root, at any depth,
  is a skill; a missing root is skipped unless `required`. To read several
  directories, list them in one instance's `roots`.
- **Ids.** The frontmatter `id` or `name`; otherwise the skill directory's
  path below the root (`release/checklist`); for a `SKILL.md` at the root
  itself, the root's name. `idPrefix` goes before each.
- **References.** Every other text file of a skill's directory, by its path
  there (`references/examples.md`, `scripts/check.sh`). Binary files, dot
  entries and `node_modules` are left out, and a file over
  `maxReferenceBytes` (64 KiB) is too.
- **Tools.** By default (`tools: "ignore"`) a file skill activates no tools.
  With `tools: "declared"`, the `tools` its frontmatter lists must be
  registered by the host or a plugin, or `Agent.define` fails with
  `skills.tools`.
- **Always-on skills** (`always: true`) are active from the first step; the
  plugin puts their instructions in a static system-prompt section. In
  code, an always-on skill takes no instructions (`defineSkill` does not
  compile with both): tool discovery never loads it, so give its tools'
  guidance in their descriptions or a prompt section.
- **Failures.** A skill id the host or another plugin also defines fails
  `Agent.define` with `skills.duplicate`: set `idPrefix`. A bad `SKILL.md`
  (no frontmatter, no description, an id already used) is logged and left
  out, or with `strict` fails with `skills.files`. More than `maxFiles`
  files or `maxBytes` of text in a root, or `maxSkills` skills, fails with
  `skills.limit`.

`readSkillFiles` and `collectSkillFiles` from `@xandreed/core` are the same
reading for a host that loads skills itself and passes them in
`capabilities`. The [plugin reference](/docs/concepts/plugin-reference/)
lists every option and its default.

## Sessions

A composable agent keeps each conversation as a session: one append-only
event log holding its turns, memory, events, host records, inbox and
background tasks. The host provides the storage (`SessionLog`: a head per
session and its events, written by compare-and-swap) and reads and writes
sessions only through `@xandreed/plugin-sessions`, as `Agent.turn` does. One
turn is open per session at a time; a second message is refused, a retried
one is found by its key. Turns are owned by a lease judged by the storage's
clock (several instances) or by the process that began them, for as long as
it runs (one host). The storage's clock is the backend's: the memory and
SQLite logs read the committing process's Effect `Clock`, under the write
lock, so instances sharing a lease over them need clocks in step; a host's
own store may read its server's clock instead. A turn keeps how it was
taken, and every instance judges it by that, whatever its own ownership, so
changing the ownership neither holds a turn forever nor reaps one still
held. Reading or following a session never runs anything.

By default a turn's lease is 60 s, extended by each of its writes and by a
keep-alive every 20 s while its writer is open (`ownership: { mode: "lease",
ttlMs: 60_000, renew: { everyMs: 20_000 } }`). The keep-alive is what lets a
step write nothing for longer than the lease, a slow model call or a long
tool, without losing its turn; the first renewal comes one interval after
the begin, so a short turn costs no extra commit. `everyMs` must be at most
half of `ttlMs` (a slower one fails with `config.options`). Each renewal is a
commit, so it moves the session's `updatedAt` (and its place in `list`).
A renewal is queued in order with the turn's writes, so it cannot pass a
`write` or `transact` still running: keep those shorter than the lease.
`renew: "on-commit"` renews on writes only, as before the keep-alive was the
default.

`Agent.turn` closes the body scope, the host's layer, then the plugins that
depend on turn services. On success, tasks and background reactions settle
between these dependency boundaries while `TurnLive` remains open. A completed
reply is recorded only after finalizer work settles; a finalizer task failure
produces a failed reply. The reply is stored with the turn's end, in one
commit right before `turn.ended`, so a reaction to it that fails stores it
failed. Failure or interruption preserves the cause, and
closing the turn's scope interrupts pending tasks; a cancelled turn does not
wait for the background reactions to its failed reply, and a failed one
waits for them ten seconds at most. A turn `Agent.turn` begins returns, as
`TurnResult.pending`, the inbox items its end left waiting (a background
task's result delivered while it ran): drain them with `Sessions.drain`.
Subscriptions in those
closing scopes cannot observe the final outcome: register an outcome observer
in the caller's outer scope with `Scope.provide(observerScope)` and services
that remain open there. The [events guide](/docs/guides/events/) shows which
subscription sees what, streams a turn to a client over SSE, and follows a
session's journal from another request or process.

A background task (`@xandreed/plugin-tasks`) is one turn of a child session,
a fork of the conversation or a fresh spawn, run by the host's `TaskRunner`;
the turn's origin is `task`. Its result lands in the parent's inbox once,
and the parent answers it after the turn in flight. `agentTaskExecutor`
from `@xandreed/sdk` runs the child's turn and the parent's reaction
through the agent, with the `Tasks` that hands them over among the turns'
services, so their `start_task` and `task_status` work (a host draining a
parent through the executor's `react` provides its `Tasks` too); build
`Tasks` beside the agent with it
(`TasksLive(tasksDefaults).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`).
See the framework guide's sessions section for the contract, the event
vocabulary and the inbox protocol.

### Automatic inbox execution

Queue user messages with `Sessions.enqueue`, choosing `delivery: "steer"`
for a running turn or `"next"` for a separate user turn. `InboxDrainLive`
from `@xandreed/plugin-sessions` runs explicit owner scopes after startup,
local wakes and periodic sweeps. Build it beside the agent with SDK's
`agentInboxRunner`, capturing the same Sessions instance. The runner uses
`Agent.turn` on the prebegun writer; the drainer owns admission and ending.

The default four fixed workers serialize each session and retry unfinished
work with bounded backoff. `resume: { _tag: "Before" }` first resumes an
eligible interrupted user root, with the configurable message `Continue.`.
`{ _tag: "Never" }` skips automatic resumption. `takeOver: true` asserts a
previous holder is gone, only for an initial startup attempt. An intentional
cancellation stops automatic resumption of that branch. Closing the scope
stops the drainer. See the framework guide for a full composition example.

### Busy signal and graceful shutdown

`SessionsPluginLive` also provides `TurnActivity` (the turns this process
holds open, with session, turn and since when, and the begins still in
progress, from before the host's admission until the writer is handed over)
and `TurnShutdown` (how it stops), and `InProcessTaskRunnerLive` provides
`TaskActivity` (the background work it runs). `processActivity` from
`@xandreed/core` reads the activity into
`{ openTurns, beginningTurns, runningTasks, waiting, queuedInput, inFlight, busy, stopping }`, and `agent.activity`
does so over the agent's runtime services: what a `/ping` reports.
`WaitingInput` counts unclaimed queued user inputs in owner-checked sessions
this instance knows, excluding notices. `DrainActivity` counts active drain
attempts. `busy` includes queued input; `inFlight` identifies running work.
`awaitIdle({ timeout })` waits for both; `queued: false` skips queue reads
and waits only for running work. A timeout reports cached queue counts.
Queue storage errors remain typed `SessionLogError`. Probes installed beside
the agent are read through `processActivity` over that composed context.

`agent.shutdown(options?)` stops the turns within a deadline, while the
services are still open: it retains queued input for restart, refuses every new begin (`TurnRefused`, reason
`shutdown`: `isShutdownRefusal`, a 503), waits until idle for the deadline
less its reserve (2 s by default), using `queued: false`, then closes the turns still running as
interrupted with the code `turn.shutdown`, their ends stored while the log
is open, and waits out the reserve. Each such turn's body is interrupted
(`Agent.turn` races its writer closing) and it can be resumed at once by
the next process. With `AgentConfig.shutdown`, closing the agent's scope
runs it first:

```ts
// Inside the host's Effect.gen, in the scope the process closes last.
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, SessionLogMemoryLive, TurnAdmissionOpen } from "@xandreed/sdk"

const sessions = SessionsPluginLive().pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
// The runner on top of the sessions: closing interrupts its tasks while the log is still open.
const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(sessions)))
const agent = yield* Agent.define({
  services, plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel],
  shutdown: { deadline: "25 seconds" },
})

// GET /ping
const ping = agent.activity.pipe(Effect.map((now) => ({ busy: now.busy, openTurns: now.openTurns.length, runningTasks: now.runningTasks })))

// SIGTERM: stop the turns within 25 s; then stop the server, then close the scope `services` lives in.
const onSigterm = agent.shutdown()
```

Closing the services without a shutdown does not stop a turn still
running: its writer lives in the turn's own scope, in the fiber serving the
request, and the close only shuts the log under it. A turn whose end could
not be stored is logged and let go of by its instance, which reaps it at
its next begin; another process reaps it as interrupted (`turn.lease`) once
its lease runs out. A background task refused by a shutdown stays pending
for the next process's `Tasks.reconcile`. The framework guide's sessions
section has the details.

The models plugin is runtime-scoped: `Agent.define` builds it once, and a
turn's own services (a per-turn `LanguageModel`) win over it. With the default
`storage: "local"` it reads existing model settings and credentials from
`.efferent` files as fallbacks; explicit plugin options and current credentials
win, and `inheritPrevious: false` gives an independent setup. With
`storage: "memory"` it never touches disk: credentials come from its options,
environment variables or the host's `HostCredentials`, settings edits stay in
memory for the agent's lifetime, and `inheritPrevious` is ignored. See
[credentials and storage](/docs/concepts/providers#credentials-and-storage).

## Evals

`@xandreed/evals` models tasks, trials, transcripts, observed outcomes, runnables, graders and suites. Applications provide the execution/environment adapters and grading-context projections. A calibration measures a grader against labelled examples; ordinary model comparisons are suites. The local Node CLI and optional Langfuse/LangSmith exporters are separate packages. See [Evaluation domain and adapters](/docs/concepts/evals/) for the interfaces and workflow.

## Distribution

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`, leaving test code out (`*.test.*`, `testing` modules and
folders). `bun run verify:packages` refuses a build that is not of `HEAD`, was made
from a tree with changes (unless `--allow-dirty`), holds test code, or whose published
entries export other names than `api/` records (`bun run api:update` rewrites it); it
packs them, installs them in a temporary external project through a temporary local npm
registry, checks it holds one copy of `@xandreed/core` and of `effect`, runs a
composable agent's turn, a session fork, sessions over SQLite with a background
task and custom evals on Bun, then imports every Node-capable package on Node.
Publishing is a separate release action.

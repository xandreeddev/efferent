# @xandreed/plugin-tasks

Background tasks: core's `Tasks` port over `Sessions`, where a task starts as a Task-origin turn of a child session whose id is the task's. The host's `TaskRunner` and `TaskExecutor` run it (the sdk's `agentTaskExecutor` runs it through an agent). A question ends its turn waiting; its parent's answer starts a later queued turn on the same child. A terminal result reaches the parent's inbox after its current turn. With `tools`, the model gets `start_task`, `task_status`, `ask_parent`, `steer_task`, `answer_task` and `cancel_task`; `InProcessTaskRunnerLive` is a `TaskRunner` on fibers of this process. Node 24 and Bun; layer `plugin-tasks` in `foundry.config.ts` (imports core only); its tests' layer `plugin-tasks-tests` also imports plugin-sessions.

## Rules

- Decide from the log alone (the parent's `task.started`, the child's `task.result` or `task.cancelled`, the parent's inbox), so any instance or a later `reconcile` can finish what another left.
- Write `task.result` in the child before its turn closes (the first of the result and the cancellation ends the task); deliver it once, under `deliveryId` (`task:<id>`), then drain the parent with `take: "notices"` so it reacts after the answer in flight. A custom `TaskExecutor.react` receives notice turns only; queued user input remains for the host's input runner.
- Record only this plugin's kinds (`TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`, `TASK_QUESTIONED`, `TASK_ANSWERED`); a refusal of one as reserved is a defect, as is a record that does not encode or a stored start the parent no longer shows: `SessionLogError` is the store's alone.
- A failed child turn stores its error's code (`harnessCodeOf`, so a tag such as `SessionContended` keeps the code its `HarnessError` form had), else `task.turn`; once the child's turn is begun, its writer's `TurnClosed` (cancelled, removed) stops the task, matched by tag, and any other writer failure is logged as one.
- Begin the initial child turn as a task's (`BeginTurn.Task`: origin `task`, its `TaskRef`). Later input turns use the child's ordinary queued input admission and borrow that exact writer in `Tasks.execute`. Recognize old initial admissions by their stable `task:<id>` key; an early queued steer must not skip the original instructions.
- A child's begin refused by a shutdown (`isShutdownRefusal`) leaves the task pending, its child untouched, for the next process's `reconcile`; any other refusal records it failed (`task.refused`).
- Hand the executor its turns (the child's, the parent's reactions) with this `Tasks` in context (`withTasks`, over the service record `TasksLive` builds, not a layer of itself): the work runs on the runner's fibers without its caller's services, the port's methods require `Tasks`, and `start_task` and `task_status` declare it, so a turn without it would fail to open its tools (`requires.missing`). `tasksConformance` checks it (`executor-tasks`).
- An agent-backed child or reaction consumes durable steers through its own writer, as ordinary turns do. Keep its exact user messages separate from task-output notices. `agentTaskExecutor`'s optional in-memory `steering` effect is forwarded to both paths; it is nondurable and does not replace queued input.
- Questions and accepted answers are durable child outboxes. A question stores full run/step provenance, the admitted input when present, and its exact framed parent notice. An answer stores its original normalized text and the exact framed, normalized delivery-next input. Replay the stored input after restart/config changes, including after consumption; InboxFull defers delivery after acceptance.
- Ask only from the current task writer. One new question per writer turn and one outstanding per task; exact retries are idempotent. Waiting remains sticky to the asking turn, trusted resume ancestry and attempts of its admitted input even after an early answer. Only the latest question's exact accepted-answer input may execute; old steers and superseded retries end bookkeeping waiting with their exact UserMessage already preserved by turn.started.
- `Tasks.execute` never begins or ends a borrowed writer. Waiting produces no task.result. Initial partial/failed/interrupted outcomes preserve the legacy terminal policy; queued follow-up partial/failed/interrupted outcomes retain their input without a terminal result. Actual hard failures never become waiting. A custom successful executor outcome after an accepted ask becomes waiting with no reply.
- Default reconcile repairs delivery and leaves parent draining to its caller. With `react: true`, schedule a TaskRunner reaction taking notices only, with metadata from the first pending task notice's starter. With explicit `takeOver: true`, an exclusive host startup may normalize an abandoned asking turn through a bookkeeping Task admission keyed by question plus abandoned turn. Invoke startup reconcile before enabling concurrent task/drainer work: boolean takeover cannot compare a named old holder.
- `CurrentTaskWriter` is an internal lexical reference around executor.turn, cleared for parent reactions. ask_parent verifies its admitted object is the exact RunContext.admitted before using it. A captured foreign writer must never authorize another turn's question.
- Waiting counts toward maxRunning without retaining a writer or runner fiber. Refuse new steering while a question waits. Cancellation wins against later controls; an exact alreadyaccepted answer remains historically accepted after terminalization but returns enqueued false and never revives delivery/execution.
- A task never starts another (`TaskRefused`, reason `depth`): judge that by the session's origin (`isTaskSession`, origin `task`), never by its lineage, so a host's own fork may start tasks. A session runs at most `maxRunning` (`limit`).
- Keep the starter's `meta` as given: what started the task goes in `task.started`'s `startedBy` (`start_task` gives the turn's run id and number), never mixed into `meta`.
- Show a task's words to the model only through `noticeOf`: inside core's `framed("task-output", …)`, clipped to `replyChars` by core's `clipTo` (a counted marker). A failure reaches the model in words: a `HarnessError`'s own message, the other `TurnError` tags described (`failureText`), never a tag's name or a store's message.
- Leave `closingReserveMs` of a runner's finite budget (at most half of it) for the result, the delivery and the parent's closing commits.
- Each `Tasks` method is a `tasks.<op>` span (`Effect.fn`, the helpers they share untraced) and a task's work a `task.run` span; they carry `efferent.session.id` (the parent's) and, for one task, `efferent.task.id`, and so do the plugin's logs: no id goes in a log message. `InProcessTaskRunnerLive`'s `run` opens no span (`Effect.fnUntraced`): the work's spans nest where the runner was built.
- `tasks.background` is an always-on skill, so its summary never reaches the model: guidance goes in the tool descriptions.
- Change behaviour by adding the check to core's `tasksConformance` or `taskRunnerConformance` first, with a careless instance in `src/tasks.conformance.test.ts` that it catches.

## Public surface

- `tasksPlugin` (also the default export) and `TasksPluginLive` (its `.live` layer); `TasksLive(config)`, `InProcessTaskRunnerLive({ maxMs })`, `tasksCapability`.
- Parent reactions use core's `Sessions.drain` with `take: "notices"`; hosts separately select and run queued user input through core's `Sessions` and an agent.
- Records and config: `TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`, `TASK_QUESTIONED`, `TASK_ANSWERED`, `TaskQuestioned`, `TaskAnswered`, `TaskStarted`, `TaskStarter`, `TaskResult`, `TaskCancelled`, `TaskOutcome`, `TasksConfig`, `tasksDefaults` (`maxRunning: 2`, `tools: false`, `replyChars: 12_000`); `deliveryId`. The notice text (`noticeOf`) stays inside the package.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import the plugin, the adapters, the records and `deliveryId`, and the rest are tagged `@public` at their declarations (`tasksPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `tasksPlugin` | `@xandreed/plugin-tasks` | runtime | `efferent/Tasks` | `efferent/Capabilities` (`tasksCapability`, with `tools`) | `efferent/Sessions`, `efferent/TaskRunner`, `efferent/TaskExecutor` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `start_task`, `task_status` and the four helper control descriptions | `src/tasks-capability.adapter.ts:6`, `:14` | exact, `src/tasks-capability.adapter.test.ts:10`, `src/tasks-capability.adapter.test.ts:15` |
| Failures: `TaskRefused` (a nested task; `maxRunning` reached), `UnknownTask`, `TasksUnavailable` | `src/tasks.adapter.ts:283`, `:305`; `src/tasks-capability.adapter.ts:50`, `:22` | exact, `src/tasks.adapter.test.ts:359`, `:355` (`start_task` returns a refusal's text as it is, `src/tasks-capability.adapter.test.ts:78`); `src/tasks-capability.adapter.test.ts:53`, `:79-80`; the nested task's refusal as a model reads it through an agent, `packages/sdk/src/tasks.journey.test.ts` |
| The notice: `[Background task <id> <how it stands>]`, the status in words (`statusText`: `completed`, `stopped before it finished`, `failed`, `was cancelled`, `was interrupted`, `has not started yet`, `is still running`; never the status's name), and the reply in `<task-output>` | `src/task.entity.functions.ts:136`, `:115-123` | exact, `src/tasks.adapter.test.ts:124`, `:271`, `:286`; every status, `src/task.entity.functions.test.ts:55` |
| A reply clipped to `replyChars` (core's `clipTo`: `[… N characters clipped]`) that cannot close the frame | `src/task.entity.functions.ts:134` | exact, `src/tasks.adapter.test.ts:577` |
| `(no reply: <failure message>)` with `task.lost`, `task.deadline` or `task.turn`'s message, or a failed turn's (a `HarnessError`'s own message; the other `TurnError` tags in words, `failureText`); `(no reply)` | `src/task.entity.functions.ts:133`, `:52`, `:96`, `:99`, `:107`, `:108`, `:79-85`, `:67-73` | exact, `src/task.entity.functions.test.ts:45-51` (`(no reply)`, `task.deadline`, `task.turn`, a tag's, a `HarnessError`'s); `src/tasks.adapter.test.ts:286` (`task.lost`), `:376`, `:432` (a host's reason) |

The following helper texts extend the model contract:

| Text | Source | Pinned by |
|---|---|---|
| Question notice fixed header/instruction, framed canonical task and question ids, and clipped question text | `src/task-controls.entity.functions.ts:37` | exact, `src/task-controls.entity.functions.test.ts:7` |
| Parent answer host note and framed canonical question id/clipped text | `src/task-controls.entity.functions.ts:43` | exact, `src/task-controls.entity.functions.test.ts:7` |
| Inactive, waiting, one-question and context refusals | `src/task-controls.entity.functions.ts:48` | exact, `src/task-controls.entity.functions.test.ts:17` |
| Waiting status in words, `needs your answer` | `src/task.entity.functions.ts:124` | exact, `src/task.entity.functions.test.ts:55` |
| Task control context/conflict failures | `src/tasks-capability.adapter.ts:45` | exact, `src/tasks-capability.adapter.test.ts:97` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | `tasksPlugin`, `TasksPluginLive` |
| `src/tasks.adapter.ts` | `TasksLive`: start, status, list, cancel, reconcile; runs a task's turn and delivers its notice |
| `src/task-runner.adapter.ts` | `InProcessTaskRunnerLive`: work on fibers of this process, and `TaskActivity` |
| `src/tasks-capability.adapter.ts` | `tasksCapability` version 2: `start_task`, `task_status`, `ask_parent`, `steer_task`, `answer_task`, `cancel_task`, the `tasks.background` skill |
| `src/task-records.entity.ts` | the records' kinds and schemas, `TasksConfig`, `tasksDefaults` |
| `src/task.entity.functions.ts` | a task's state from its records, `resultOf`, `deliveryId`, `noticeOf` |
| `src/task-controls.entity.functions.ts` | durable question/answer projections, provenance, pending notice metadata and framed text |
| `src/tasks-context.port.ts` | private lexical current task writer reference |
| `src/index.ts` | the public exports |

## Tests

- `src/tasks.adapter.test.ts`: delivery after the turn in flight, starting and storing, recovery, cancel and removal, limits, failures and budgets, the notice, the spans and the logs' ids, over `SessionsLive` and the in-memory log; `src/tasks-capability.adapter.test.ts` (the tools and their failures), `src/task-runner.adapter.test.ts` (`TaskActivity`) and `src/task.entity.functions.test.ts` (the delivered ids, an undecodable `inbox.queued` failing with `session.decode`, the notice of each way a task ends without a reply).
- `src/tasks.conformance.test.ts`: core's `taskRunnerConformance` over `InProcessTaskRunnerLive` (with and without `maxMs`), `tasksConformance` over `TasksLive`, and the Tasks kit's self-tests.
- Elsewhere: `packages/sdk/src/agent.adapter.test.ts` runs a background task under `Agent.turn`; `packages/sdk/src/tasks.journey.test.ts` runs one end to end through an agent (`start_task`, the child's turn by `agentTaskExecutor`, delivery, `pending`, the caller's drain; a task's own `start_task` refused for depth, a reaction's starting another task, the `Tasks` among a turn's services); `activity.test.ts` counts the runner's work in `awaitIdle`; `journal-compat.test.ts` decodes the task records of every release's fixture; `verify:packages` runs the kits on Node and a task over SQLite on Bun.
- Run: `bun test packages/plugin-tasks packages/sdk/src/activity.test.ts packages/sdk/src/journal-compat.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.

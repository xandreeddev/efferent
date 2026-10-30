# @xandreed/plugin-tasks

Background tasks: core's `Tasks` port over `Sessions`, where a task is one turn of a child session whose id is the task's, run by the host's `TaskRunner` and `TaskExecutor` (the sdk's `agentTaskExecutor` runs it through an agent), its result delivered to the parent's inbox for the turn after the one in flight. With `tools`, the model gets `start_task` and `task_status`; `InProcessTaskRunnerLive` is a `TaskRunner` on fibers of this process. Node 24 and Bun; layer `plugin-tasks` in `foundry.config.ts` (imports core only); its tests' layer `plugin-tasks-tests` also imports plugin-sessions.

## Rules

- Decide from the log alone (the parent's `task.started`, the child's `task.result` or `task.cancelled`, the parent's inbox), so any instance or a later `reconcile` can finish what another left.
- Write `task.result` in the child before its turn closes (the first of the result and the cancellation ends the task); deliver it once, under `deliveryId` (`task:<id>`), then drain the parent so it reacts after the answer in flight.
- Record only this plugin's kinds (`TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`); a refusal of one as reserved is a defect, as is a record that does not encode or a stored start the parent no longer shows: `SessionLogError` is the store's alone.
- A failed child turn stores its error's code (`harnessCodeOf`, so a tag such as `SessionContended` keeps the code its `HarnessError` form had), else `task.turn`; once the child's turn is begun, its writer's `TurnClosed` (cancelled, removed) stops the task, matched by tag, and any other writer failure is logged as one.
- Begin the child's turn as a task's (`BeginTurn.Task`: origin `task`, its `TaskRef`), never as a user's.
- Hand the executor its turns (the child's, the parent's reactions) with this `Tasks` in context (`withTasks`, over the service record `TasksLive` builds, not a layer of itself): the work runs on the runner's fibers without its caller's services, the port's methods require `Tasks`, and `start_task` and `task_status` declare it, so a turn without it would fail to open its tools (`requires.missing`). `tasksConformance` checks it (`executor-tasks`).
- A task never starts another (`TaskRefused`, reason `depth`): judge that by the session's origin (`isTaskSession`, origin `task`), never by its lineage, so a host's own fork may start tasks. A session runs at most `maxRunning` (`limit`).
- Keep the starter's `meta` as given: what started the task goes in `task.started`'s `startedBy` (`start_task` gives the turn's run id and number), never mixed into `meta`.
- Show a task's words to the model only through `noticeOf`: inside core's `framed("task-output", …)`, clipped to `replyChars` by core's `clipTo` (a counted marker). A failure reaches the model in words: a `HarnessError`'s own message, the other `TurnError` tags described (`failureText`), never a tag's name or a store's message.
- Leave `closingReserveMs` of a runner's finite budget (at most half of it) for the result, the delivery and the parent's closing commits.
- Each `Tasks` method is a `tasks.<op>` span (`Effect.fn`, the helpers they share untraced) and a task's work a `task.run` span; they carry `efferent.session.id` (the parent's) and, for one task, `efferent.task.id`, and so do the plugin's logs: no id goes in a log message. `InProcessTaskRunnerLive`'s `run` opens no span (`Effect.fnUntraced`): the work's spans nest where the runner was built.
- `tasks.background` is an always-on skill, so its summary never reaches the model: guidance goes in the tool descriptions.
- Change behaviour by adding the check to core's `tasksConformance` or `taskRunnerConformance` first, with a careless instance in `src/tasks.conformance.test.ts` that it catches.

## Public surface

- `tasksPlugin` (also the default export) and `TasksPluginLive` (its `.live` layer); `TasksLive(config)`, `InProcessTaskRunnerLive({ maxMs })`, `tasksCapability`.
- Records and config: `TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`, `TaskStarted`, `TaskStarter`, `TaskResult`, `TaskCancelled`, `TaskOutcome`, `TasksConfig`, `tasksDefaults` (`maxRunning: 2`, `tools: false`, `replyChars: 12_000`); `deliveryId`. The notice text (`noticeOf`) stays inside the package.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import the plugin, the adapters, the records and `deliveryId`, and the rest are tagged `@public` at their declarations (`tasksPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `tasksPlugin` | `@xandreed/plugin-tasks` | runtime | `efferent/Tasks` | `efferent/Capabilities` (`tasksCapability`, with `tools`) | `efferent/Sessions`, `efferent/TaskRunner`, `efferent/TaskExecutor` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `start_task` and `task_status` descriptions | `src/tasks-capability.adapter.ts:6`, `:14` | exact, `src/tasks-capability.adapter.test.ts:10` |
| Failures: `TaskRefused` (a nested task; `maxRunning` reached), `UnknownTask`, `TasksUnavailable` | `src/tasks.adapter.ts:279`, `:301`; `src/tasks-capability.adapter.ts:50`, `:22` | exact, `src/tasks.adapter.test.ts:358`, `:354` (`start_task` returns a refusal's text as it is, `src/tasks-capability.adapter.test.ts:78`); `src/tasks-capability.adapter.test.ts:53`, `:79-80`; the nested task's refusal as a model reads it through an agent, `packages/sdk/src/tasks.journey.test.ts` |
| The notice: `[Background task <id> <how it stands>]`, the status in words (`statusText`: `completed`, `stopped before it finished`, `failed`, `was cancelled`, `was interrupted`, `has not started yet`, `is still running`; never the status's name), and the reply in `<task-output>` | `src/task.entity.functions.ts:135`, `:114-122` | exact, `src/tasks.adapter.test.ts:123`, `:270`, `:285`; every status, `src/task.entity.functions.test.ts:53` |
| A reply clipped to `replyChars` (core's `clipTo`: `[… N characters clipped]`) that cannot close the frame | `src/task.entity.functions.ts:133` | exact, `src/tasks.adapter.test.ts:555` |
| `(no reply: <failure message>)` with `task.lost`, `task.deadline` or `task.turn`'s message, or a failed turn's (a `HarnessError`'s own message; the other `TurnError` tags in words, `failureText`); `(no reply)` | `src/task.entity.functions.ts:132`, `:52`, `:95`, `:98`, `:106`, `:107`, `:78-84` | exact, `src/task.entity.functions.test.ts:44-49` (`(no reply)`, `task.deadline`, `task.turn`, a tag's, a `HarnessError`'s); `src/tasks.adapter.test.ts:285` (`task.lost`), `:375`, `:410` (a host's reason) |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | `tasksPlugin`, `TasksPluginLive` |
| `src/tasks.adapter.ts` | `TasksLive`: start, status, list, cancel, reconcile; runs a task's turn and delivers its notice |
| `src/task-runner.adapter.ts` | `InProcessTaskRunnerLive`: work on fibers of this process, and `TaskActivity` |
| `src/tasks-capability.adapter.ts` | `tasksCapability`: `start_task`, `task_status`, the `tasks.background` skill |
| `src/task-records.entity.ts` | the records' kinds and schemas, `TasksConfig`, `tasksDefaults` |
| `src/task.entity.functions.ts` | a task's state from its records, `resultOf`, `deliveryId`, `noticeOf` |
| `src/index.ts` | the public exports |

## Tests

- `src/tasks.adapter.test.ts`: delivery after the turn in flight, starting and storing, recovery, cancel and removal, limits, failures and budgets, the notice, the spans and the logs' ids, over `SessionsLive` and the in-memory log; `src/tasks-capability.adapter.test.ts` (the tools and their failures), `src/task-runner.adapter.test.ts` (`TaskActivity`) and `src/task.entity.functions.test.ts` (the delivered ids, an undecodable `inbox.queued` failing with `session.decode`, the notice of each way a task ends without a reply).
- `src/tasks.conformance.test.ts`: core's `taskRunnerConformance` over `InProcessTaskRunnerLive` (with and without `maxMs`), `tasksConformance` over `TasksLive`, and the Tasks kit's self-tests.
- Elsewhere: `packages/sdk/src/agent.adapter.test.ts` runs a background task under `Agent.turn`; `packages/sdk/src/tasks.journey.test.ts` runs one end to end through an agent (`start_task`, the child's turn by `agentTaskExecutor`, delivery, `pending`, the caller's drain; a task's own `start_task` refused for depth, a reaction's starting another task, the `Tasks` among a turn's services); `activity.test.ts` counts the runner's work in `awaitIdle`; `journal-compat.test.ts` decodes the task records of every release's fixture; `verify:packages` runs the kits on Node and a task over SQLite on Bun.
- Run: `bun test packages/plugin-tasks packages/sdk/src/activity.test.ts packages/sdk/src/journal-compat.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.

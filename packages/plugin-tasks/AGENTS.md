# @xandreed/plugin-tasks

Background tasks: core's `Tasks` port over `Sessions`, where a task is one turn of a child session whose id is the task's, run by the host's `TaskRunner` and `TaskExecutor`, its result delivered to the parent's inbox for the turn after the one in flight. With `tools`, the model gets `start_task` and `task_status`; `InProcessTaskRunnerLive` is a `TaskRunner` on fibers of this process. Node 24 and Bun; layer `plugin-tasks` in `foundry.config.ts` (imports core only); its tests' layer `plugin-tasks-tests` also imports plugin-sessions.

## Rules

- Decide from the log alone (the parent's `task.started`, the child's `task.result` or `task.cancelled`, the parent's inbox), so any instance or a later `reconcile` can finish what another left.
- Write `task.result` in the child before its turn closes (the first of the result and the cancellation ends the task); deliver it once, under `deliveryId` (`task:<id>`), then drain the parent so it reacts after the answer in flight.
- Record only this plugin's kinds (`TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`); a refusal of one as reserved is a defect, as is a record that does not encode or a stored start the parent no longer shows: `SessionLogError` is the store's alone.
- A failed child turn stores its error's code (`harnessCodeOf`, so a tag such as `SessionContended` keeps the code its `HarnessError` form had), else `task.turn`; once the child's turn is begun, its writer's `TurnClosed` (cancelled, removed) stops the task, matched by tag, and any other writer failure is logged as one.
- A task never starts another (`TaskRefused`, reason `depth`), and a session runs at most `maxRunning` (`limit`).
- Show a task's words to the model only through `noticeOf`: inside core's `framed("task-output", …)`, cut at `replyChars` with a marker.
- Leave `closingReserveMs` of a runner's finite budget (at most half of it) for the result, the delivery and the parent's closing commits.
- Each `Tasks` method is a `tasks.<op>` span (`Effect.fn`, the helpers they share untraced) and a task's work a `task.run` span; they carry `efferent.session.id` (the parent's) and, for one task, `efferent.task.id`, and so do the plugin's logs: no id goes in a log message. `InProcessTaskRunnerLive`'s `run` opens no span (`Effect.fnUntraced`): the work's spans nest where the runner was built.
- `tasks.background` is an always-on skill, so its summary never reaches the model: guidance goes in the tool descriptions.
- Change behaviour by adding the check to core's `tasksConformance` or `taskRunnerConformance` first, with a careless instance in `src/tasks.conformance.test.ts` that it catches.

## Public surface

- `tasksPlugin` (also the default export) and `TasksPluginLive` (its `.live` layer); `TasksLive(config)`, `InProcessTaskRunnerLive({ maxMs })`, `tasksCapability`.
- Records and config: `TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`, `TaskStarted`, `TaskResult`, `TaskCancelled`, `TaskOutcome`, `TasksConfig`, `tasksDefaults` (`maxRunning: 2`, `tools: false`, `replyChars: 12_000`); `deliveryId`, `noticeOf`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `tasksPlugin` | `@xandreed/plugin-tasks` | runtime | `efferent/Tasks` | `efferent/Capabilities` (`tasksCapability`, with `tools`) | `efferent/Sessions`, `efferent/TaskRunner`, `efferent/TaskExecutor` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `start_task` and `task_status` descriptions | `src/tasks-capability.adapter.ts:6`, `:14` | exact, `src/tasks-capability.adapter.test.ts:10` |
| Failures: `TaskRefused` (a nested task; `maxRunning` reached), `UnknownTask`, `TasksUnavailable` | `src/tasks.adapter.ts:257`, `:274`; `src/tasks-capability.adapter.ts:45`, `:21` | `TaskRefused` reasons only, `src/tasks.adapter.test.ts:344`; every message unpinned |
| The notice: `[Background task <id> <status>]` and the reply in `<task-output>` | `src/task.entity.functions.ts:99` | exact, `src/tasks.adapter.test.ts:107`, `:269`, `:357` |
| A reply cut at `replyChars` (`(cut at N characters)`) that cannot close the frame | `src/task.entity.functions.ts:97` | contains and exact, `src/tasks.adapter.test.ts:518` |
| `(no reply: <failure message>)` with `task.lost`, `task.deadline` or `task.turn`'s message, or a failed turn's (a `HarnessError`'s own message; `reasonOf` for a tag such as `SessionContended`); `(no reply)` | `src/task.entity.functions.ts:96`, `:52`, `:71`, `:74`, `:82`, `:83` | exact for `task.lost` and a host's reason, `src/tasks.adapter.test.ts:269`, `:357`, `:386`; `(no reply)`, `task.deadline`, `task.turn` and a tag's message unpinned |

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

- `src/tasks.adapter.test.ts`: delivery after the turn in flight, starting and storing, recovery, cancel and removal, limits, failures and budgets, the notice, the spans and the logs' ids, over `SessionsLive` and the in-memory log; `src/tasks-capability.adapter.test.ts` (the tools), `src/task-runner.adapter.test.ts` (`TaskActivity`) and `src/task.entity.functions.test.ts` (the delivered ids, an undecodable `inbox.queued` failing with `session.decode`).
- `src/tasks.conformance.test.ts`: core's `taskRunnerConformance` over `InProcessTaskRunnerLive` (with and without `maxMs`), `tasksConformance` over `TasksLive`, and the Tasks kit's self-tests.
- Elsewhere: `packages/sdk/src/agent.adapter.test.ts` runs a background task under `Agent.turn`; `activity.test.ts` counts the runner's work in `awaitIdle`; `journal-compat.test.ts` decodes the task records of every release's fixture; `verify:packages` runs the kits on Node and a task over SQLite on Bun.
- Run: `bun test packages/plugin-tasks packages/sdk/src/activity.test.ts packages/sdk/src/journal-compat.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.

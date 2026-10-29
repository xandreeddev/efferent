# @xandreed/plugin-tasks

Background tasks: core's `Tasks` port over `Sessions`, where a task is one turn of a child session whose id is the task's, run by the host's `TaskRunner` and `TaskExecutor`, its result delivered to the parent's inbox for the turn after the one in flight. With `tools`, the model gets `start_task` and `task_status`; `InProcessTaskRunnerLive` is a `TaskRunner` on fibers of this process. Node 24 and Bun; layer `plugin-tasks` in `foundry.config.ts` (imports core only); its tests' layer `plugin-tasks-tests` also imports plugin-sessions.

## Rules

- Decide from the log alone (the parent's `task.started`, the child's `task.result` or `task.cancelled`, the parent's inbox), so any instance or a later `reconcile` can finish what another left.
- Write `task.result` in the child before its turn closes (the first of the result and the cancellation ends the task); deliver it once, under `deliveryId` (`task:<id>`), then drain the parent so it reacts after the answer in flight.
- Record only this plugin's kinds (`TASK_STARTED`, `TASK_RESULT`, `TASK_CANCELLED`); a reserved kind fails as `tasks.kind`.
- A task never starts another (`TaskRefused`, reason `depth`), and a session runs at most `maxRunning` (`limit`).
- Show a task's words to the model only through `noticeOf`: inside core's `framed("task-output", …)`, cut at `replyChars` with a marker.
- Leave `closingReserveMs` of a runner's finite budget (at most half of it) for the result, the delivery and the parent's closing commits.
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
| Failures: `TaskRefused` (a nested task; `maxRunning` reached), `UnknownTask`, `TasksUnavailable` | `src/tasks.adapter.ts:239`, `:256`; `src/tasks-capability.adapter.ts:45`, `:21` | `TaskRefused` reasons only, `src/tasks.adapter.test.ts:297`; every message unpinned |
| The notice: `[Background task <id> <status>]` and the reply in `<task-output>` | `src/task.entity.functions.ts:90` | exact, `src/tasks.adapter.test.ts:95`, `:236`, `:310` |
| A reply cut at `replyChars` (`(cut at N characters)`) that cannot close the frame | `src/task.entity.functions.ts:88` | contains and exact, `src/tasks.adapter.test.ts:454` |
| `(no reply: <failure message>)` with `task.lost`, `task.deadline` or `task.turn`'s message; `(no reply)` | `src/task.entity.functions.ts:87`, `:51`, `:65`, `:68`, `:75` | exact for `task.lost` and a host's reason, `src/tasks.adapter.test.ts:236`, `:310`, `:321`; `(no reply)`, `task.deadline` and `task.turn` unpinned |

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

- `src/tasks.adapter.test.ts`: delivery after the turn in flight, starting and storing, recovery, cancel and removal, limits, failures and budgets, the notice, over `SessionsLive` and the in-memory log; `src/tasks-capability.adapter.test.ts` (the tools) and `src/task-runner.adapter.test.ts` (`TaskActivity`).
- `src/tasks.conformance.test.ts`: core's `taskRunnerConformance` over `InProcessTaskRunnerLive` (with and without `maxMs`), `tasksConformance` over `TasksLive`, and the Tasks kit's self-tests.
- Elsewhere: `packages/sdk/src/agent.adapter.test.ts` runs a background task under `Agent.turn`; `activity.test.ts` counts the runner's work in `awaitIdle`; `journal-compat.test.ts` decodes the task records of every release's fixture; `verify:packages` runs the kits on Node and a task over SQLite on Bun.
- Run: `bun test packages/plugin-tasks packages/sdk/src/activity.test.ts packages/sdk/src/journal-compat.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.

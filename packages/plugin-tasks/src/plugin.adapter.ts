import { Layer } from "effect"
import { Capabilities, definePlugin, Sessions, TaskExecutor, TaskRunner, Tasks } from "@xandreed/core"
import { tasksCapability } from "./tasks-capability.adapter.js"
import { TasksConfig, tasksDefaults } from "./task-records.entity.js"
import { TasksLive } from "./tasks.adapter.js"

/**
 * Background tasks: a task is one turn of a child session, run by the
 * host's TaskRunner and TaskExecutor, its result delivered to the parent's
 * inbox for the turn after the one in flight. With `tools`, the model gets
 * `start_task` and `task_status`.
 */
export const tasksPlugin = definePlugin({
  id: "@xandreed/plugin-tasks", version: "0.7.0-next.1", scope: "runtime",
  config: TasksConfig, defaults: tasksDefaults,
  requires: [Sessions, TaskRunner, TaskExecutor],
  provides: [Tasks],
  contributes: [Capabilities],
  layer: (config) => Layer.mergeAll(TasksLive(config), Layer.succeed(Capabilities, config.tools ? [tasksCapability] : [])),
})
/** Background tasks as a typed layer: provides Tasks (and, with `tools`, their capability); requires Sessions, TaskRunner and TaskExecutor. */
export const TasksPluginLive = tasksPlugin.live
export default tasksPlugin

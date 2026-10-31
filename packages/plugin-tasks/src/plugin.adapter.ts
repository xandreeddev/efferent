import { Layer } from "effect"
import { Capabilities, definePlugin, Sessions, TaskExecutor, TaskRunner, Tasks } from "@xandreed/core"
import { tasksCapability } from "./tasks-capability.adapter.js"
import { TasksConfig, tasksDefaults } from "./task-records.entity.js"
import { TasksLive } from "./tasks.adapter.js"

/**
 * Background tasks over child sessions, run by the host's TaskRunner and
 * TaskExecutor. A question yields waiting and its answer starts a queued
 * follow-up turn. The final result reaches the parent's inbox after its
 * current turn. With `tools`, the model can start, inspect, steer, answer
 * and cancel tasks, and a helper can ask its parent.
 *
 * @public
 */
export const tasksPlugin = definePlugin({
  id: "@xandreed/plugin-tasks", version: "0.14.0", scope: "runtime",
  config: TasksConfig, defaults: tasksDefaults,
  requires: [Sessions, TaskRunner, TaskExecutor],
  provides: [Tasks],
  contributes: [Capabilities],
  layer: (config) => Layer.mergeAll(TasksLive(config), Layer.succeed(Capabilities, config.tools ? [tasksCapability] : [])),
})
/**
 * Background tasks as a typed layer: provides Tasks (and, with `tools`, their capability); requires Sessions, TaskRunner and TaskExecutor.
 *
 * @public
 */
export const TasksPluginLive = tasksPlugin.live
export default tasksPlugin

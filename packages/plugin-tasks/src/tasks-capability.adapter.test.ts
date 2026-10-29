import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref } from "effect"
import { ConversationId, RunContext, Tasks } from "@xandreed/core"
import type { TaskView } from "@xandreed/core"
import { tasksCapability } from "./tasks-capability.adapter.js"

const [startTask, taskStatus] = tasksCapability.tools

describe("the model's task tools", () => {
  test("start_task says what a fork sees, that instructions carry the rest, and that tasks do not nest", () => {
    expect(startTask!.tool.description).toBe("Start a background task: another run of you works on the instructions while this conversation goes on, and its result comes back here when it finishes, for you to answer then. Use it for long work the user need not wait for, and say that you started it. Put everything the task needs in instructions: with mode spawn it sees only them; with mode fork it also sees this conversation up to the user's latest message, but not that message or anything you did since. A background task cannot start another.")
    expect(taskStatus!.tool.description).toBe("Check a background task this conversation started: whether it is still running, and its result once it has one.")
  })

  test("start_task starts the task with the turn's own meta and the run that started it", async () => {
    const started = await Effect.runPromise(Effect.gen(function* () {
      const inputs = yield* Ref.make<ReadonlyArray<unknown>>([])
      const taskId = ConversationId.make("00000000-0000-4000-8000-0000000007a1")
      const view: TaskView = {
        taskId, parent: ConversationId.make("00000000-0000-4000-8000-0000000007a2"), child: taskId, instructions: "x", mode: "spawn",
        status: "pending", reply: Option.none(), failure: Option.none(), delivered: false,
      }
      const tasks = Tasks.of({ start: (_parent: unknown, input: unknown) => Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as(view)) } as never)
      const run = RunContext.of({ session: { id: view.parent, owner: "owner-1" }, runId: "run-7", admitted: { meta: { tenant: "acme" } } } as never)
      // The registry erases a handler's requirements; this one needs the run and the tasks.
      const output = yield* (startTask!.handler({ instructions: "count", mode: "spawn" }).pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run)) as Effect.Effect<unknown, unknown>)
      return { output, inputs: yield* Ref.get(inputs) }
    }))
    expect(started).toEqual({
      output: { taskId: "00000000-0000-4000-8000-0000000007a1", status: "pending" },
      inputs: [{ instructions: "count", mode: "spawn", meta: { tenant: "acme", runId: "run-7" } }],
    })
  })
})

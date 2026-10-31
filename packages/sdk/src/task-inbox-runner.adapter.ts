import { Context, Effect, Layer, Option } from "effect"
import { harnessError, InboxRunner, Sessions, Tasks } from "@xandreed/core"
import type { TurnWriter } from "@xandreed/core"

/**
 * Route a task child's queued follow-ups through Tasks.execute on the supplied
 * borrowed writer. Other sessions use base. After an acknowledged end, repair
 * task delivery and hand parent notices to the existing task runner. The hook
 * can be skipped on process death; startup Tasks.reconcile repairs the outbox.
 * Build beside the agent with the drainer's own Sessions and Tasks.
 * @public
 */
export const taskInboxRunner = (base: Context.Service.Shape<typeof InboxRunner>): Layer.Layer<InboxRunner, never, Sessions | Tasks> => Layer.effect(InboxRunner, Effect.gen(function* () {
  const sessions = yield* Sessions
  const tasks = yield* Tasks
  const sessionOf = (writer: TurnWriter) => sessions.get(writer.admitted.session).pipe(
    Effect.catchTag("SessionMissing", (cause) => Effect.fail(harnessError("task.turn", "The inbox session is unavailable.", cause))),
  )
  return InboxRunner.of({
    run: Effect.fn("task_inbox_runner.run")(function* (writer) {
      const view = yield* sessionOf(writer)
      return yield* view.header.origin === "task" ? tasks.execute(writer) : base.run(writer)
    }),
    afterEnd: Effect.fn("task_inbox_runner.after_end")(function* (writer, ending) {
      const view = yield* sessionOf(writer)
      if (view.header.origin === "task") {
        const parent = yield* Option.match(view.header.parent, {
          onNone: () => Effect.fail(harnessError("task.turn", "The task session has no parent.")),
          onSome: (lineage) => Effect.succeed({ id: lineage.id, owner: writer.admitted.session.owner }),
        })
        yield* tasks.reconcile(parent, { react: true }).pipe(
          Effect.catchTag("SessionMissing", (cause) => Effect.fail(harnessError("task.turn", "The inbox session is unavailable.", cause))),
        )
      }
      if (base.afterEnd !== undefined) yield* base.afterEnd(writer, ending)
    }),
  })
}))

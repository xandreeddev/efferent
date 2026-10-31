import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { isTurnError, TaskExecutor, Tasks } from "@xandreed/core"
import type { TaskView, Turn, TurnError, TurnInput, TurnOutcome, TurnRunner, TurnServices, TurnWriter } from "@xandreed/core"

/** What a task's turn runs once it is composed: a `use` of `Agent.turn`, with the turn's services. */
type TurnUse = (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>

/** The turn's skills selected for its message (the always-on ones and the matcher's), then one run of the step loop: its text is the reply. */
const oneRun = (turn: Turn): Effect.Effect<TurnOutcome, TurnError> => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({})),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text) })),
)

/**
 * A turn the tasks plugin began, run through the agent: its writer is
 * handed over, so nothing is begun here and the plugin ends the turn. A
 * begin refusal cannot happen then: one would be a broken runner, a defect.
 * The turn's services are the host's with the `Tasks` the executor is
 * called with, so the turn's task tools (`start_task`, `task_status`) find
 * the `Tasks` whose work the turn is.
 */
const runOn = (agent: TurnRunner, services: Context.Context<never>, writer: TurnWriter, use: TurnUse, steering: TurnInput["steering"], waiting?: TurnInput["waiting"]) => Tasks.pipe(
  Effect.flatMap((tasks) => agent.turn({ turn: writer, services: Context.add(services, Tasks, tasks), ...(steering === undefined ? {} : { steering }), ...(waiting === undefined ? {} : { waiting }) }, use)),
  Effect.catch((error) => isTurnError(error) ? Effect.fail(error) : Effect.die(error)),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: result.reply })),
)

/**
 * The `TaskExecutor` that runs a task's turns through an agent (`Agent.turn`,
 * or any `TurnRunner`) with the turn's `services` (its model, the host's
 * per-turn ports) and the `Tasks` it is called with (the tasks plugin's
 * own), so a turn's `start_task` and `task_status` work: the child's one
 * turn with `child` and the parent's
 * reaction to a result with `react`, each by default the turn's skills
 * selected for its message, then one run of the step loop, whose text is the
 * reply. The tasks plugin begins and ends those turns; this only runs them.
 * Build `Tasks` beside the agent, not inside it:
 * `TasksLive(config).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`
 * (a `tasksPlugin` among the agent's own plugins would need the executor
 * before the agent exists).
 *
 * @public
 */
export const agentTaskExecutor = (agent: TurnRunner, options: {
  readonly services: Context.Context<never>
  /** Optional in-memory steering for both turns; durable input uses their writers' queued steers. */
  readonly steering?: TurnInput["steering"]
  /** The child's turn, given the task it runs. */
  readonly child?: (turn: Turn, task: TaskView) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>
  /** The parent's turn that answers the results waiting in its inbox. */
  readonly react?: TurnUse
}): Layer.Layer<TaskExecutor> => {
  const child = options.child ?? oneRun
  const react = options.react ?? oneRun
  return Layer.succeed(TaskExecutor, TaskExecutor.of({
    turn: (writer, task, controls) => runOn(agent, options.services, writer, (turn) => child(turn, task), options.steering, controls?.waiting),
    react: (writer) => runOn(agent, options.services, writer, react, options.steering).pipe(Effect.asVoid),
  }))
}

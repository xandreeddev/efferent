import { Effect, Layer, Option } from "effect"
import type { Context, Scope } from "effect"
import { isTurnError, TaskExecutor } from "@xandreed/core"
import type { TaskView, Turn, TurnError, TurnOutcome, TurnRunner, TurnServices, TurnWriter } from "@xandreed/core"

/** What a task's turn runs once it is composed: a `use` of `Agent.turn`, with the turn's services. */
type TurnUse = (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>

/** The turn's skills selected for its message (the always-on ones and the matcher's), then one run of the step loop: its text is the reply. */
const oneRun = (turn: Turn): Effect.Effect<TurnOutcome, TurnError> => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({})),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

/**
 * A turn the tasks plugin began, run through the agent: its writer is
 * handed over, so nothing is begun here and the plugin ends the turn. A
 * begin refusal cannot happen then: one would be a broken runner, a defect.
 */
const runOn = (agent: TurnRunner, services: Context.Context<never>, writer: TurnWriter, use: TurnUse) =>
  agent.turn({ turn: writer, services }, use).pipe(
    Effect.catch((error) => isTurnError(error) ? Effect.fail(error) : Effect.die(error)),
    Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: result.reply })),
  )

/**
 * The `TaskExecutor` that runs a task's turns through an agent (`Agent.turn`,
 * or any `TurnRunner`) with the turn's `services` (its model, the host's
 * per-turn ports): the child's one turn with `child` and the parent's
 * reaction to a result with `react`, each by default the turn's skills
 * selected for its message, then one run of the step loop, whose text is the
 * reply. The tasks plugin begins and ends those turns; this only runs them.
 * Build `Tasks` beside the agent, not inside it:
 * `TasksLive(config).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`
 * (a `tasksPlugin` among the agent's own plugins would need the executor
 * before the agent exists).
 */
export const agentTaskExecutor = (agent: TurnRunner, options: {
  readonly services: Context.Context<never>
  /** The child's turn, given the task it runs. */
  readonly child?: (turn: Turn, task: TaskView) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>
  /** The parent's turn that answers the results waiting in its inbox. */
  readonly react?: TurnUse
}): Layer.Layer<TaskExecutor> => {
  const child = options.child ?? oneRun
  const react = options.react ?? oneRun
  return Layer.succeed(TaskExecutor, TaskExecutor.of({
    turn: (writer, task) => runOn(agent, options.services, writer, (turn) => child(turn, task)),
    react: (writer) => runOn(agent, options.services, writer, react).pipe(Effect.asVoid),
  }))
}

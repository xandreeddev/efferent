import { Effect, Match, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { COMMAND_TIMEOUT_LIMIT, CommandRun, RUN_COMMAND } from "../../contracts/shell/shell.entity.js"
import type { ShellRefused, ShellUnavailable } from "../../contracts/shell/shell.entity.js"
import { COMMAND_EMPTY, commandRunOf, shellRefused } from "../../contracts/shell/shell.entity.functions.js"
import { Shell } from "../../contracts/shell/shell.port.js"

/**
 * The tool that runs a command on the host's machine (ADR 0028), through the `Shell` the host provides. It asks no
 * one: whether a command may run is the app's, which gives a `Shell` that declines, asks in its loop before the call,
 * or leaves the tool out. Its parameters are the command and a time, never an environment or a folder: the shell's
 * are the host's.
 *
 * @public
 */
export const RunCommand = Tool.make(RUN_COMMAND, {
  description: `Run a command in a shell (sh -c) on the host's machine, with the host's rights, starting in the host's folder; it reads no input. Returns how it \`ended\` ("exited", "timed out" or "killed"), its \`exitCode\` when it exited, and the end of its \`stdout\` and \`stderr\`: when either is longer than the shell keeps, \`stdoutCut\` or \`stderrCut\` counts the bytes left out before it. A command still running after \`timeoutSeconds\` is stopped, with every process it started; so is anything it leaves running in the background when it returns.`,
  parameters: Schema.Struct({
    command: Schema.String.annotate({ description: "The command, as you would type it in a terminal, such as ls -la or npm test." }),
    timeoutSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMMAND_TIMEOUT_LIMIT })).annotate({
      description: `How long the command may run, in seconds, at most ${COMMAND_TIMEOUT_LIMIT}. Left out, the host's default.`,
    })),
  }),
  success: CommandRun,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Shell],
})

/**
 * The shell's one tool: a host merges it into its own toolkit, `Toolkit.merge(tools, shellTools)`, which keeps its
 * type, so a program that leaves `Shell` out does not compile where it calls it.
 *
 * @public
 */
export const shellTools = Toolkit.make(RunCommand)

/** A failure of `Shell` as the model reads it; a shell that cannot run anything is a defect, as a store's failure is. */
const said = (error: ShellRefused | ShellUnavailable): Effect.Effect<never, string> => Match.valueTags(error, {
  ShellRefused: ({ reason }) => Effect.fail(shellRefused(reason)),
  ShellUnavailable: (unavailable) => Effect.die(unavailable),
})

/**
 * What `runCommand` does, over the `Shell` the host provides. An exit code that is not 0, a timeout and a signal are
 * results the model reads; an empty command and a command the shell declines are failed results in fixed words; a
 * shell that cannot run anything is a defect.
 *
 * @public
 */
export const shellHandlers = shellTools.toLayer({
  runCommand: ({ command, timeoutSeconds }) => Effect.gen(function* () {
    if (command.trim().length === 0) return yield* Effect.fail(COMMAND_EMPTY)
    const shell = yield* Shell
    const ran = yield* shell.run(timeoutSeconds === undefined ? { command } : { command, timeoutMs: timeoutSeconds * 1000 }).pipe(Effect.catch(said))
    return commandRunOf(ran)
  }),
})

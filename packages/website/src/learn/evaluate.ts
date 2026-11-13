// Running the learner's code: an expression evaluated with the names its file
// imports, and its failures said in words. Shared by every lesson.
import { Cause, Effect, Exit, Layer, Option, Predicate, Result } from "effect"

/**
 * Evaluate a JavaScript expression with the given names in scope. It is no
 * sandbox (globals stay reachable); it only keeps the names the program
 * imports the ones the learner's code sees, so a name it does not import
 * fails as "not defined".
 */
export const evaluate = (source: string, names: Record<string, unknown>): unknown => {
  const keys = Object.keys(names)
  return new Function(...keys, `"use strict"; return (${source}\n)`)(...keys.map((key) => names[key]))
}

export const textOf = (error: unknown): string =>
  error instanceof Error ? error.message
    : Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message
      : String(error)

/** Why a build failed, in words: the error a part failed with, or the defect (a missing service, or an error thrown by the learner's code). */
export const buildFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  const reason = Option.isSome(failure) ? textOf(failure.value) : Cause.prettyErrors(cause)[0]?.message ?? "the stack did not build"
  const missing = /Service not found: (\S+)/.exec(reason)?.[1]
  if (missing !== undefined) return `nothing in the stack provides ${missing.split("/").at(-1)}, and a part above it needs it (${reason}).`
  const thrown = Option.isNone(failure) ? Cause.prettyErrors(cause)[0]?.name : undefined
  return thrown !== undefined && /^(Reference|Type|Range)Error$/.test(thrown) ? `your code threw a ${thrown} while the agent was built: ${reason}` : reason
}

/** Evaluate one file's code; a failure is said in words, after `prefix` (such as "agent.ts did not run: "). */
export const run = (prefix: string, source: string, names: Record<string, unknown>): Result.Result<unknown, string> => {
  const made = Effect.runSync(Effect.exit(Effect.try({ try: () => evaluate(source, names), catch: textOf })))
  return Exit.isFailure(made) ? Result.fail(`${prefix}${buildFailure(made.cause)}`) : Result.succeed(made.value)
}

/**
 * Effect's `Layer`, as the learner's code sees it: the same module, but a
 * part given to `provideMerge` that is no layer is refused when the
 * expression is evaluated, in words, rather than deep inside the build.
 * `example` shows a call the lesson's code makes, for the most common slip:
 * a function given, not called.
 */
export const checkedLayer = (example: string) => ({
  ...Layer,
  provideMerge: (...parts: ReadonlyArray<unknown>) => {
    const bad = parts.find((part) => !Layer.isLayer(part))
    if (bad !== undefined || parts.length === 0) {
      throw new Error(Predicate.isFunction(bad)
        ? `Layer.provideMerge was given a function, not a layer. Call it: ${example}.`
        : `Layer.provideMerge was given ${bad === undefined ? "undefined" : typeof bad}, not a layer.`)
    }
    return Reflect.apply(Layer.provideMerge, undefined, parts)
  },
})

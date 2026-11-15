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

/**
 * Run statements with the given names in scope and return the value of the
 * expression `result` names after them (`main`). No sandbox, as `evaluate`.
 */
export const evaluateStatements = (body: string, result: string, names: Record<string, unknown>): unknown => {
  const keys = Object.keys(names)
  return new Function(...keys, `"use strict";\n${body}\n;return ${result}`)(...keys.map((key) => names[key]))
}

/** Run one file's statements and return `result`; a failure is said in words, after `prefix`. */
export const runStatements = (prefix: string, body: string, result: string, names: Record<string, unknown>): Result.Result<unknown, string> => {
  const made = Effect.runSync(Effect.exit(Effect.try({ try: () => evaluateStatements(body, result, names), catch: textOf })))
  return Exit.isFailure(made) ? Result.fail(`${prefix}${buildFailure(made.cause)}`) : Result.succeed(made.value)
}

/** Evaluate one file's code; a failure is said in words, after `prefix` (such as "agent.ts did not run: "). */
export const run = (prefix: string, source: string, names: Record<string, unknown>): Result.Result<unknown, string> => {
  const made = Effect.runSync(Effect.exit(Effect.try({ try: () => evaluate(source, names), catch: textOf })))
  return Exit.isFailure(made) ? Result.fail(`${prefix}${buildFailure(made.cause)}`) : Result.succeed(made.value)
}

/**
 * A name a file made, read as it is: the page runs untyped JavaScript, and holds what a file made to no type. A
 * lesson checks what it needs of the value with a guard (`Layer.isLayer`, `typeof`), and hands the rest on as it
 * came. `undefined` when the file made no such name.
 */
export const named = (made: unknown, name: string): unknown => (Predicate.hasProperty(made, name) ? made[name] : undefined)

/**
 * The learner's `main`, as the page runs it: an Effect, or why it is not one. The learner's code is untyped
 * JavaScript, so nothing can say before it runs what its program still needs. This is the one place the page
 * says it needs nothing more: a module `main` was not given is found when the program runs, and reported as a
 * defect ("nothing in the stack provides …"). The typed modules the tests compile say the same of their `run`,
 * and there the compiler checks it.
 */
export const programOf = (main: unknown): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Effect.isEffect(main)
    ? Result.succeed(main as Effect.Effect<unknown, unknown>)
    : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide.")

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

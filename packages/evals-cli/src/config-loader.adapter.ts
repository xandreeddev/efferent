import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { Cause, Effect, Predicate } from "effect"
import { EvaluationError, parseEvaluationApp, reasonOf, type EvaluationApp } from "@xandreed/evals"

/** The module's default export, or what it returns for the arguments when it is a function. */
const importDefault = (path: string, args: ReadonlyArray<string>): Effect.Effect<unknown, EvaluationError> => Effect.tryPromise({
  try: async (): Promise<unknown> => {
    const { tsImport } = await import("tsx/esm/api")
    const module: unknown = await tsImport(pathToFileURL(resolve(path)).href, import.meta.url)
    const exported = Predicate.hasProperty(module, "default") ? module.default : undefined
    return Predicate.isFunction(exported) ? await exported(args) : exported
  },
  catch: (error) => new EvaluationError({ code: "invalid", message: `Cannot load evaluation configuration ${path}: ${reasonOf(Cause.die(error))}`, cause: error }),
})

/**
 * Caller chooses the module; its declaration must not acquire model or infrastructure clients. The default export goes through `parseEvaluationApp`.
 *
 * @public
 */
export const loadEvaluationApp = (path: string, args: ReadonlyArray<string> = []): Effect.Effect<EvaluationApp, EvaluationError> =>
  importDefault(path, args).pipe(Effect.flatMap(parseEvaluationApp))

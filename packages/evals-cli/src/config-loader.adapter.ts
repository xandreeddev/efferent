import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { Effect } from "effect"
import { EvaluationError, type EvaluationApp } from "@xandreed/evals"

/** Caller chooses the module; its declaration must not acquire model or infrastructure clients. */
export const loadEvaluationApp = (path: string, args: ReadonlyArray<string> = []): Effect.Effect<EvaluationApp, EvaluationError> => Effect.tryPromise({
  try: async () => {
    const { tsImport } = await import("tsx/esm/api")
    const module: { default: EvaluationApp | ((args: ReadonlyArray<string>) => EvaluationApp | Promise<EvaluationApp>) } = await tsImport(pathToFileURL(resolve(path)).href, import.meta.url)
    return typeof module.default === "function" ? await module.default(args) : module.default
  },
  catch: (error) => new EvaluationError({ code: "invalid", message: `Cannot load evaluation configuration: ${String(error)}` }),
})
